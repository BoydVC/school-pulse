import type { DatabaseSync } from "node:sqlite";
import type { NormalizedAssignment, NormalizedGrade, NormalizedSnapshot } from "../adapters/types.js";
import { enforceSnapshot } from "../domain/enforce.js";
import { formatDuePhrase } from "../model/dates.js";
import {
  describeDueChange,
  describeGradeChange,
  describeMoved,
  describeNewAssignment,
  describeScoreChange,
  describeStatusChange,
} from "../model/english.js";
import type { Assignment, Change, Course, GradeSnapshot, Student } from "../model/types.js";
import {
  countAssignmentsBySource,
  getAssignmentBySource,
  getCourseBySource,
  getGradeAt,
  getStudentBySource,
  insertAssignment,
  insertChange,
  insertCourse,
  insertGrade,
  insertStudent,
  latestGrade,
  transaction,
  updateAssignment,
  updateCourse,
  updateGrade,
  updateStudent,
} from "../store/db.js";
import { numEq } from "../util/text.js";
import { evaluateAlerts } from "../alerts/alerts.js";
import type { Alert } from "../model/types.js";

export interface IngestResult {
  unchanged: boolean;
  studentsInserted: number;
  studentsUpdated: number;
  coursesInserted: number;
  coursesUpdated: number;
  assignmentsInserted: number;
  assignmentsUpdated: number;
  gradesInserted: number;
  changes: Change[];
  alerts: Alert[];
}

interface Draft {
  studentId: string | null;
  courseId: string | null;
  assignmentId: string | null;
  kind: Change["kind"];
  summary: string;
  before: string | null;
  after: string | null;
}

export function ingestSnapshot(db: DatabaseSync, snapshot: NormalizedSnapshot, now: Date): IngestResult {
  return transaction(db, () => applySnapshot(db, snapshot, now));
}

function applySnapshot(db: DatabaseSync, incoming: NormalizedSnapshot, now: Date): IngestResult {
  const snapshot = enforceSnapshot(incoming);
  const fetchedAt = snapshot.fetchedAt || now.toISOString();
  const existingAssignments = countAssignmentsBySource(db, snapshot.source);
  const result: IngestResult = {
    unchanged: false,
    studentsInserted: 0,
    studentsUpdated: 0,
    coursesInserted: 0,
    coursesUpdated: 0,
    assignmentsInserted: 0,
    assignmentsUpdated: 0,
    gradesInserted: 0,
    changes: [],
    alerts: [],
  };
  const drafts: Draft[] = [];
  const students = new Map<string, Student>();
  for (const incoming of snapshot.students) {
    const stored = upsertStudent(db, snapshot.source, incoming, fetchedAt, result);
    students.set(incoming.sourceId, stored);
  }
  const courses = new Map<string, Course>();
  for (const incoming of snapshot.courses) {
    const student = requireStudent(students, incoming.studentSourceId);
    const stored = upsertCourse(db, snapshot.source, incoming, student, fetchedAt, result);
    courses.set(courseKey(incoming.studentSourceId, incoming.sourceId), stored);
  }

  const newAssignments: Assignment[] = [];
  for (const incoming of snapshot.assignments) {
    const student = requireStudent(students, incoming.studentSourceId);
    const course = requireCourse(courses, incoming.studentSourceId, incoming.courseSourceId);
    const existing = getAssignmentBySource(db, snapshot.source, incoming.sourceId);
    if (!existing) {
      const created = insertAssignment(db, {
        studentId: student.id,
        courseId: course.id,
        title: incoming.title,
        due: incoming.due,
        assigned: incoming.assigned,
        status: incoming.status,
        pointsEarned: incoming.pointsEarned,
        pointsPossible: incoming.pointsPossible,
        category: incoming.category,
        url: incoming.url,
        source: snapshot.source,
        sourceId: incoming.sourceId,
        lastSeen: fetchedAt,
        fetchedAt,
      });
      result.assignmentsInserted += 1;
      newAssignments.push(created);
      continue;
    }
    if (sameAssignment(existing, incoming, course.id)) continue;
    if (existing.due !== incoming.due) {
      drafts.push({
        studentId: student.id,
        courseId: course.id,
        assignmentId: existing.id,
        kind: "assignment_due",
        summary: describeDueChange(incoming.title, formatDuePhrase(incoming.due, now)),
        before: existing.due,
        after: incoming.due,
      });
    }
    if (existing.courseId !== course.id) {
      drafts.push({
        studentId: student.id,
        courseId: course.id,
        assignmentId: existing.id,
        kind: "assignment_moved",
        summary: describeMoved(incoming.title, course.name),
        before: existing.courseId,
        after: course.id,
      });
    }
    if (existing.status !== incoming.status) {
      drafts.push({
        studentId: student.id,
        courseId: course.id,
        assignmentId: existing.id,
        kind: "assignment_status",
        summary: describeStatusChange(incoming.title, incoming.status, incoming.pointsEarned, incoming.pointsPossible),
        before: existing.status,
        after: incoming.status,
      });
    } else if (!numEq(existing.pointsEarned, incoming.pointsEarned) || !numEq(existing.pointsPossible, incoming.pointsPossible)) {
      drafts.push({
        studentId: student.id,
        courseId: course.id,
        assignmentId: existing.id,
        kind: "assignment_score",
        summary: describeScoreChange(incoming.title, incoming.pointsEarned, incoming.pointsPossible),
        before: scoreText(existing.pointsEarned, existing.pointsPossible),
        after: scoreText(incoming.pointsEarned, incoming.pointsPossible),
      });
    } else if (existing.title !== incoming.title) {
      drafts.push({
        studentId: student.id,
        courseId: course.id,
        assignmentId: existing.id,
        kind: "assignment_status",
        summary: `${existing.title} renamed to ${incoming.title}`,
        before: existing.title,
        after: incoming.title,
      });
    }
    updateAssignment(db, {
      ...existing,
      studentId: student.id,
      courseId: course.id,
      title: incoming.title,
      due: incoming.due,
      assigned: incoming.assigned,
      status: incoming.status,
      pointsEarned: incoming.pointsEarned,
      pointsPossible: incoming.pointsPossible,
      category: incoming.category,
      url: incoming.url,
      lastSeen: fetchedAt,
      fetchedAt,
    });
    result.assignmentsUpdated += 1;
  }

  const emitNew = !(existingAssignments === 0 && newAssignments.length > 3);
  if (emitNew) {
    for (const assignment of newAssignments) {
      drafts.push({
        studentId: assignment.studentId,
        courseId: assignment.courseId,
        assignmentId: assignment.id,
        kind: "assignment_new",
        summary: describeNewAssignment(assignment.title, formatDuePhrase(assignment.due, now)),
        before: null,
        after: assignment.title,
      });
    }
  }

  const gradesByCourse = new Map<string, NormalizedGrade[]>();
  for (const grade of snapshot.grades) {
    const key = courseKey(grade.studentSourceId, grade.courseSourceId);
    gradesByCourse.set(key, [...(gradesByCourse.get(key) ?? []), grade]);
  }
  for (const [key, grades] of gradesByCourse) {
    const course = courses.get(key);
    if (!course) continue;
    const applied = applyGrades(db, course, grades, snapshot.source, fetchedAt);
    result.gradesInserted += applied.inserted;
    if (applied.draft) drafts.push(applied.draft);
  }

  const base = new Date(fetchedAt).getTime();
  result.changes = drafts.map((draft, index) =>
    insertChange(db, {
      ...draft,
      source: snapshot.source,
      fetchedAt,
      createdAt: new Date(base + index).toISOString(),
    }),
  );
  result.alerts = evaluateAlerts(db, now);
  result.unchanged =
    result.studentsInserted +
      result.studentsUpdated +
      result.coursesInserted +
      result.coursesUpdated +
      result.assignmentsInserted +
      result.assignmentsUpdated +
      result.gradesInserted +
      result.changes.length +
      result.alerts.length ===
    0;
  return result;
}

function applyGrades(
  db: DatabaseSync,
  course: Course,
  grades: NormalizedGrade[],
  source: string,
  fetchedAt: string,
): { inserted: number; draft: Draft | null } {
  const before = latestGrade(db, course.id);
  let inserted = 0;
  const sorted = grades.slice().sort((a, b) => a.asOf.localeCompare(b.asOf));
  for (const grade of sorted) {
    const at = getGradeAt(db, course.id, grade.asOf);
    if (at && sameGrade(at, grade)) continue;
    if (at) {
      updateGrade(db, { ...at, percent: grade.percent, letter: grade.letter, fetchedAt });
      inserted += 1;
      continue;
    }
    if (before && grade.asOf > before.asOf && sameGrade(before, grade)) continue;
    insertGrade(db, {
      studentId: course.studentId,
      courseId: course.id,
      percent: grade.percent,
      letter: grade.letter,
      asOf: grade.asOf,
      source,
      fetchedAt,
    });
    inserted += 1;
  }
  const after = latestGrade(db, course.id);
  if (!before || !after || sameGrade(before, after)) return { inserted, draft: null };
  return {
    inserted,
    draft: {
      studentId: course.studentId,
      courseId: course.id,
      assignmentId: null,
      kind: "grade",
      summary: describeGradeChange(course.name, before.percent, before.letter, after.percent, after.letter),
      before: before.percent != null ? String(before.percent) : before.letter,
      after: after.percent != null ? String(after.percent) : after.letter,
    },
  };
}

function upsertStudent(
  db: DatabaseSync,
  source: string,
  incoming: NormalizedSnapshot["students"][number],
  fetchedAt: string,
  result: IngestResult,
): Student {
  const existing = getStudentBySource(db, source, incoming.sourceId);
  if (!existing) {
    result.studentsInserted += 1;
    return insertStudent(db, {
      source,
      sourceId: incoming.sourceId,
      name: incoming.name,
      school: incoming.school,
      gradeLevel: incoming.gradeLevel,
      fetchedAt,
    });
  }
  if (
    existing.name === incoming.name &&
    existing.school === incoming.school &&
    existing.gradeLevel === incoming.gradeLevel
  ) {
    return existing;
  }
  const next = { ...existing, name: incoming.name, school: incoming.school, gradeLevel: incoming.gradeLevel, fetchedAt };
  updateStudent(db, next);
  result.studentsUpdated += 1;
  return next;
}

function upsertCourse(
  db: DatabaseSync,
  source: string,
  incoming: NormalizedSnapshot["courses"][number],
  student: Student,
  fetchedAt: string,
  result: IngestResult,
): Course {
  const existing = getCourseBySource(db, source, incoming.sourceId);
  if (!existing) {
    result.coursesInserted += 1;
    return insertCourse(db, {
      studentId: student.id,
      source,
      sourceId: incoming.sourceId,
      name: incoming.name,
      teacher: incoming.teacher,
      period: incoming.period,
      fetchedAt,
    });
  }
  if (existing.studentId !== student.id) {
    throw new Error(`Course ${incoming.sourceId} from ${source} is already linked to another student.`);
  }
  if (existing.name === incoming.name && existing.teacher === incoming.teacher && existing.period === incoming.period) {
    return existing;
  }
  const next = { ...existing, name: incoming.name, teacher: incoming.teacher, period: incoming.period, fetchedAt };
  updateCourse(db, next);
  result.coursesUpdated += 1;
  return next;
}

function sameAssignment(existing: Assignment, incoming: NormalizedAssignment, courseId: string): boolean {
  return (
    existing.courseId === courseId &&
    existing.title === incoming.title &&
    existing.due === incoming.due &&
    existing.assigned === incoming.assigned &&
    existing.status === incoming.status &&
    numEq(existing.pointsEarned, incoming.pointsEarned) &&
    numEq(existing.pointsPossible, incoming.pointsPossible) &&
    existing.category === incoming.category &&
    existing.url === incoming.url
  );
}

function sameGrade(existing: GradeSnapshot | { percent: number | null; letter: string | null }, grade: { percent: number | null; letter: string | null }): boolean {
  return numEq(existing.percent, grade.percent) && (existing.letter ?? null) === (grade.letter ?? null);
}

function requireStudent(students: Map<string, Student>, sourceId: string): Student {
  const student = students.get(sourceId);
  if (!student) throw new Error(`Assignment or course references unknown student "${sourceId}".`);
  return student;
}

function requireCourse(courses: Map<string, Course>, studentSourceId: string, courseSourceId: string): Course {
  const course = courses.get(courseKey(studentSourceId, courseSourceId));
  if (!course) throw new Error(`Assignment references unknown course "${courseSourceId}".`);
  return course;
}

function courseKey(studentSourceId: string, courseSourceId: string): string {
  return `${studentSourceId}\u0000${courseSourceId}`;
}

function scoreText(earned: number | null, possible: number | null): string {
  return `${earned ?? "—"}/${possible ?? "—"}`;
}
