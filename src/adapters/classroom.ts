import type { AssignmentStatus } from "../model/types.js";
import { parseLooseDate } from "../model/dates.js";
import { asNumber, asString, slug } from "../util/text.js";
import { emptySnapshot, type NormalizedSnapshot } from "./types.js";

interface LooseRecord {
  [key: string]: unknown;
}

export function parseClassroom(raw: string, now: Date): NormalizedSnapshot {
  const data = JSON.parse(raw) as LooseRecord;
  const fetchedAt = asString(data.fetchedAt) ?? now.toISOString();
  const snapshot = emptySnapshot("google-classroom", fetchedAt);
  const students = arrayOf(data.students).map((student) => {
    const profile = (student.profile ?? {}) as LooseRecord;
    const name = (profile.name ?? {}) as LooseRecord;
    const fullName = asString(name.fullName) ?? asString(student.name) ?? "Student";
    return {
      sourceId: asString(student.userId ?? student.sourceId ?? student.id) ?? slug(fullName),
      name: fullName,
      school: asString(student.school),
      gradeLevel: asString(student.gradeLevel),
    };
  });
  if (students.length === 0) students.push({ sourceId: "student", name: "Student", school: null, gradeLevel: null });
  snapshot.students = students;
  const only = students.length === 1 ? students[0]!.sourceId : null;

  const teacherByCourse = new Map<string, string>();
  for (const teacher of arrayOf(data.teachers)) {
    const profile = (teacher.profile ?? {}) as LooseRecord;
    const name = (profile.name ?? {}) as LooseRecord;
    const courseId = asString(teacher.courseId);
    const fullName = asString(name.fullName);
    if (courseId && fullName) teacherByCourse.set(courseId, fullName);
  }

  const catalog = new Map<string, { name: string; period: string | null }>();
  for (const course of arrayOf(data.courses)) {
    if (asString(course.courseState) === "ARCHIVED") continue;
    const courseId = asString(course.id);
    const name = asString(course.name);
    if (!courseId || !name) continue;
    catalog.set(courseId, { name, period: asString(course.section) });
  }

  const describe = (courseId: string, studentSourceId: string): void => {
    const known = catalog.get(courseId);
    ensureCourse(snapshot, {
      sourceId: courseId,
      studentSourceId,
      name: known?.name ?? "Class",
      teacher: teacherByCourse.get(courseId) ?? null,
      period: known?.period ?? null,
    });
  };

  const workById = new Map<string, LooseRecord>();
  for (const work of arrayOf(data.courseWork)) {
    const id = asString(work.id);
    if (id) workById.set(`${asString(work.courseId)}:${id}`, work);
  }

  const seen = new Set<string>();
  for (const submission of arrayOf(data.studentSubmissions)) {
    const courseId = asString(submission.courseId);
    const workId = asString(submission.courseWorkId);
    const userId = asString(submission.userId) ?? only;
    if (!courseId || !workId || !userId) continue;
    const work = workById.get(`${courseId}:${workId}`);
    if (!work || skipWork(work)) continue;
    const title = asString(work.title);
    if (!title) continue;
    describe(courseId, userId);
    const due = classroomDue(work, now);
    const earned = asNumber(submission.assignedGrade ?? submission.draftGrade);
    const sourceId = asString(submission.id) ?? `${courseId}:${workId}:${userId}`;
    seen.add(`${courseId}:${workId}:${userId}`);
    snapshot.assignments.push({
      sourceId,
      studentSourceId: userId,
      courseSourceId: courseId,
      title,
      due,
      assigned: asString(work.creationTime),
      status: classroomStatus(submission, due, now),
      pointsEarned: earned,
      pointsPossible: asNumber(work.maxPoints),
      category: asString(work.workType) ?? "Assignment",
      url: asString(submission.alternateLink ?? work.alternateLink),
    });
  }

  for (const work of arrayOf(data.courseWork)) {
    if (skipWork(work)) continue;
    const courseId = asString(work.courseId);
    const workId = asString(work.id);
    const title = asString(work.title);
    if (!courseId || !workId || !title) continue;
    const targets = only ? [only] : [];
    for (const userId of targets) {
      if (seen.has(`${courseId}:${workId}:${userId}`)) continue;
      describe(courseId, userId);
      const due = classroomDue(work, now);
      snapshot.assignments.push({
        sourceId: `${courseId}:${workId}:${userId}`,
        studentSourceId: userId,
        courseSourceId: courseId,
        title,
        due,
        assigned: asString(work.creationTime),
        status: due && new Date(due).getTime() < now.getTime() ? "missing" : "assigned",
        pointsEarned: null,
        pointsPossible: asNumber(work.maxPoints),
        category: asString(work.workType) ?? "Assignment",
        url: asString(work.alternateLink),
      });
    }
  }

  for (const grade of arrayOf(data.grades)) {
    const studentSourceId = asString(grade.studentSourceId ?? grade.userId ?? grade.studentId) ?? only;
    const courseSourceId = asString(grade.courseSourceId ?? grade.courseId);
    if (!studentSourceId || !courseSourceId) continue;
    if (!catalog.has(courseSourceId) && asString(grade.courseName)) {
      catalog.set(courseSourceId, { name: asString(grade.courseName) ?? "Class", period: null });
    }
    describe(courseSourceId, studentSourceId);
    const percent = asNumber(grade.percent);
    const letter = asString(grade.letter);
    if (percent == null && !letter) continue;
    const asOf = asString(grade.asOf);
    snapshot.grades.push({
      studentSourceId,
      courseSourceId,
      percent,
      letter,
      asOf: asOf ? parseLooseDate(asOf, now)?.toISOString() ?? fetchedAt : fetchedAt,
    });
  }

  return snapshot;
}

function classroomDue(work: LooseRecord, now: Date): string | null {
  const direct = asString(work.due);
  if (direct) return parseLooseDate(direct, now)?.toISOString() ?? null;
  const dueDate = work.dueDate as LooseRecord | undefined;
  if (!dueDate) return null;
  const year = asNumber(dueDate.year);
  const month = asNumber(dueDate.month);
  const day = asNumber(dueDate.day);
  if (!year || !month || !day) return null;
  const dueTime = (work.dueTime ?? {}) as LooseRecord;
  const hours = asNumber(dueTime.hours) ?? 23;
  const minutes = asNumber(dueTime.minutes) ?? 59;
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function classroomStatus(submission: LooseRecord, due: string | null, now: Date): AssignmentStatus {
  const state = (asString(submission.state) ?? "CREATED").toUpperCase();
  const past = due != null && new Date(due).getTime() < now.getTime();
  const earned = asNumber(submission.assignedGrade ?? submission.draftGrade);
  if ((state === "RETURNED" || state === "TURNED_IN") && earned != null) return "graded";
  if (submission.late === true && (state === "TURNED_IN" || state === "RETURNED")) return "late";
  if (submission.late === true && past) return "late";
  if ((state === "CREATED" || state === "NEW" || state === "RECLAIMED_BY_STUDENT") && past) return "missing";
  if (state === "TURNED_IN" || state === "RETURNED") return "turned_in";
  return "assigned";
}

function skipWork(work: LooseRecord): boolean {
  const type = (asString(work.workType) ?? "ASSIGNMENT").toUpperCase();
  return type === "MATERIAL" || type === "ANNOUNCEMENT";
}

function ensureCourse(snapshot: NormalizedSnapshot, course: NormalizedSnapshot["courses"][number]): void {
  const existing = snapshot.courses.find((item) => item.sourceId === course.sourceId && item.studentSourceId === course.studentSourceId);
  if (!existing) snapshot.courses.push(course);
  else {
    if (course.name !== "Class") existing.name = course.name;
    existing.teacher ??= course.teacher;
    existing.period ??= course.period;
  }
}

function arrayOf(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? (value as LooseRecord[]) : [];
}
