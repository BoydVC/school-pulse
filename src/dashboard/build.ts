import type { DatabaseSync } from "node:sqlite";
import {
  addDays,
  clockParts,
  dayHeading,
  endOfDay,
  formatDueLabel,
  formatDuePhrase,
  formatWhen,
  isSameDay,
  startOfDay,
  startOfWeek,
} from "../model/dates.js";
import { activeTimezone } from "../time/zone.js";
import { describeDueChange, describeNewAssignment, formatPercent } from "../model/english.js";
import { compareSources, freshnessBadge, sourceLabel } from "../model/freshness.js";
import type { Assignment, Change, Course } from "../model/types.js";
import { listAssignments, listChanges, listCourses, listGrades, listGradesForCourse, listStudents } from "../store/db.js";
import { studentKey } from "../util/text.js";

export interface AttentionItem {
  id: string;
  studentKey: string;
  studentName: string;
  courseName: string;
  title: string;
  status: string;
  due: string | null;
  dueLabel: string;
  pointsLabel: string | null;
  category: string | null;
  source: string;
  sourceLabel: string;
}

export interface GradeRow {
  id: string;
  studentKey: string;
  studentName: string;
  courseName: string;
  teacher: string | null;
  period: string | null;
  percent: number | null;
  percentLabel: string;
  letter: string | null;
  delta: number | null;
  spark: number[];
  source: string;
  sourceLabel: string;
  asOf: string | null;
}

export interface StudentCard {
  key: string;
  name: string;
  school: string;
  gradeLevel: string | null;
  missingCount: number;
  lateCount: number;
  dueTonightCount: number;
  grades: GradeRow[];
}

export interface ChangeItem {
  id: string;
  summary: string;
  studentKey: string | null;
  studentName: string | null;
  courseName: string | null;
  source: string;
  sourceLabel: string;
  when: string;
  at: string;
  kind: string;
  assignmentId: string | null;
  courseId: string | null;
}

export interface DashboardData {
  now: string;
  timezone: string;
  clock: { weekday: string; date: string; time: string };
  schools: string;
  tonight: {
    kicker: string;
    headline: string[];
    detail: string;
    clear: boolean;
    doneTonight: number;
    items: AttentionItem[];
  };
  missing: AttentionItem[];
  week: {
    overdue: AttentionItem[];
    days: Array<{ iso: string; label: string; dateLabel: string; isToday: boolean; items: AttentionItem[] }>;
  };
  grades: GradeRow[];
  students: StudentCard[];
  changes: ChangeItem[];
  sources: Array<{ source: string; label: string; state: "fresh" | "aging" | "stale"; text: string; fetchedAt: string }>;
  counts: { students: number; assignments: number; sources: number; missing: number };
}

export function buildDashboard(db: DatabaseSync, now: Date): DashboardData {
  const students = listStudents(db);
  const courses = listCourses(db);
  const assignments = listAssignments(db).filter((assignment) => !assignment.removed);
  const grades = listGrades(db);
  const changes = listChanges(db);
  const studentById = new Map(students.map((student) => [student.id, student]));
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));

  const nameOf = (studentId: string): string => studentById.get(studentId)?.name ?? "Student";
  const keyOf = (studentId: string): string => studentKey(nameOf(studentId));

  const toAttention = (assignment: Assignment): AttentionItem => {
    const course = courseById.get(assignment.courseId);
    return {
      id: assignment.id,
      studentKey: keyOf(assignment.studentId),
      studentName: nameOf(assignment.studentId),
      courseName: course?.name ?? "Class",
      title: assignment.title,
      status: assignment.status,
      due: assignment.due,
      dueLabel: formatDueLabel(assignment.due, assignment.status, now),
      pointsLabel: pointsLabel(assignment.pointsEarned, assignment.pointsPossible),
      category: assignment.category,
      source: assignment.source,
      sourceLabel: sourceLabel(assignment.source),
    };
  };

  const tonightItems = assignments
    .filter((assignment) => isTonight(assignment, now))
    .map(toAttention)
    .sort(compareAttention);
  const missingCount = tonightItems.filter((item) => item.status === "missing").length;
  const lateCount = tonightItems.filter((item) => item.status === "late").length;
  const dueCount = tonightItems.filter((item) => item.status === "assigned").length;
  const clear = missingCount + lateCount + dueCount === 0;
  const headline = clear
    ? ["You're clear tonight"]
    : [
        missingCount ? `${missingCount} missing` : "",
        lateCount ? `${lateCount} late` : "",
        dueCount ? `${dueCount} due tonight` : "",
      ].filter(Boolean);
  const oldest = tonightItems.find((item) => item.status === "missing");
  const nextUp = assignments
    .filter((assignment) => assignment.status === "assigned" && assignment.due && new Date(assignment.due).getTime() > endOfDay(now).getTime())
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))[0];
  const detail = !clear && oldest
    ? `Oldest is ${oldest.title}, ${oldest.dueLabel.toLowerCase()}.`
    : clear && nextUp
      ? `Next up · ${nextUp.title} · ${formatDuePhrase(nextUp.due, now)}`
      : clear
        ? "Nothing due, missing, or late."
        : "Still open before tomorrow.";

  const gradeRows = courses
    .map((course) => toGrade(course, nameOf(course.studentId), keyOf(course.studentId), listGradesForCourse(db, course.id)))
    .sort((a, b) => a.studentName.localeCompare(b.studentName) || periodRank(a.period) - periodRank(b.period) || a.courseName.localeCompare(b.courseName));

  const groups = new Map<string, { name: string; school: string[]; gradeLevel: string | null; ids: Set<string> }>();
  for (const student of students) {
    const key = studentKey(student.name);
    const group = groups.get(key) ?? { name: student.name.trim(), school: [], gradeLevel: null, ids: new Set<string>() };
    group.ids.add(student.id);
    if (student.school && !group.school.includes(student.school)) group.school.push(student.school);
    group.gradeLevel ??= student.gradeLevel;
    groups.set(key, group);
  }

  const cards: StudentCard[] = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      name: group.name,
      school: group.school.join(" · "),
      gradeLevel: group.gradeLevel,
      missingCount: tonightItems.filter((item) => item.studentKey === key && item.status === "missing").length,
      lateCount: tonightItems.filter((item) => item.studentKey === key && item.status === "late").length,
      dueTonightCount: tonightItems.filter((item) => item.studentKey === key && item.status === "assigned").length,
      grades: gradeRows.filter((row) => row.studentKey === key),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const overdue = assignments
    .filter((assignment) => (assignment.status === "missing" || assignment.status === "late") && assignment.due && new Date(assignment.due).getTime() < startOfDay(now).getTime())
    .map(toAttention)
    .sort(compareAttention);
  const overdueIds = new Set(overdue.map((item) => item.id));
  const weekStart = startOfWeek(now);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    return {
      iso: startOfDay(date).toISOString(),
      label: dayHeading(date, now),
      dateLabel: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: activeTimezone() }),
      isToday: isSameDay(date, now),
      items: assignments
        .filter((assignment) => assignment.due && isSameDay(new Date(assignment.due), date) && !overdueIds.has(assignment.id))
        .map(toAttention)
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  });

  const freshest = new Map<string, string>();
  const bump = (source: string, iso: string): void => {
    const previous = freshest.get(source);
    if (!previous || iso > previous) freshest.set(source, iso);
  };
  for (const student of students) bump(student.source, student.fetchedAt);
  for (const course of courses) bump(course.source, course.fetchedAt);
  for (const assignment of assignments) bump(assignment.source, assignment.fetchedAt);
  for (const grade of grades) bump(grade.source, grade.fetchedAt);

  const schools = [...new Set(students.map((student) => student.school).filter((school): school is string => Boolean(school)))].sort();

  const timeZone = activeTimezone();
  return {
    now: now.toISOString(),
    timezone: timeZone,
    clock: clockParts(now, timeZone),
    schools: schools.join(" · "),
    tonight: {
      kicker: clear ? "Tonight" : "Needs you tonight",
      headline,
      detail,
      clear,
      doneTonight: assignments.filter((assignment) => doneTonight(assignment, now)).length,
      items: tonightItems,
    },
    missing: tonightItems.filter((item) => item.status === "missing" || item.status === "late"),
    week: { overdue, days },
    grades: gradeRows,
    students: cards,
    changes: changes.map((change) => toChange(change, now, studentById, courseById, assignmentById)),
    sources: [...freshest.entries()]
      .sort((a, b) => compareSources(a[0], b[0]))
      .map(([source, fetchedAt]) => {
        const badge = freshnessBadge(source, fetchedAt, now);
        return { source, label: sourceLabel(source), state: badge.state, text: badge.text, fetchedAt };
      }),
    counts: {
      students: cards.length,
      assignments: assignments.length,
      sources: freshest.size,
      missing: tonightItems.filter((item) => item.status === "missing").length,
    },
  };
}

function toGrade(course: Course, studentName: string, key: string, snaps: ReturnType<typeof listGradesForCourse>): GradeRow {
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length >= 2 ? snaps[snaps.length - 2] : undefined;
  const delta =
    latest?.percent != null && previous?.percent != null ? Math.round(latest.percent - previous.percent) : null;
  return {
    id: course.id,
    studentKey: key,
    studentName,
    courseName: course.name,
    teacher: course.teacher,
    period: course.period,
    percent: latest?.percent ?? null,
    percentLabel: latest?.percent != null ? formatPercent(latest.percent) : "—",
    letter: latest?.letter ?? null,
    delta: delta === 0 ? null : delta,
    spark: snaps.flatMap((snap) => (snap.percent == null ? [] : [snap.percent])),
    source: course.source,
    sourceLabel: sourceLabel(course.source),
    asOf: latest?.asOf ?? null,
  };
}

function toChange(
  change: Change,
  now: Date,
  students: Map<string, { name: string }>,
  courses: Map<string, { name: string }>,
  assignments: Map<string, Assignment>,
): ChangeItem {
  const assignment = change.assignmentId ? assignments.get(change.assignmentId) : undefined;
  let summary = change.summary;
  if (assignment && change.kind === "assignment_new") summary = describeNewAssignment(assignment.title, formatDuePhrase(assignment.due, now));
  if (assignment && change.kind === "assignment_due") summary = describeDueChange(assignment.title, formatDuePhrase(assignment.due, now));
  const studentId = change.studentId ?? assignment?.studentId ?? null;
  return {
    id: change.id,
    summary,
    studentKey: studentId ? studentKey(students.get(studentId)?.name ?? "") : null,
    studentName: studentId ? students.get(studentId)?.name ?? null : null,
    courseName: change.courseId ? courses.get(change.courseId)?.name ?? null : null,
    source: change.source,
    sourceLabel: sourceLabel(change.source),
    when: formatWhen(change.createdAt, now),
    at: change.createdAt,
    kind: change.kind,
    assignmentId: change.assignmentId,
    courseId: change.courseId,
  };
}

function isTonight(assignment: Assignment, now: Date): boolean {
  if (assignment.status === "missing" || assignment.status === "late") return true;
  return assignment.status === "assigned" && assignment.due != null && isSameDay(new Date(assignment.due), now);
}

function doneTonight(assignment: Assignment, now: Date): boolean {
  if (!assignment.due || !isSameDay(new Date(assignment.due), now)) return false;
  return assignment.status === "turned_in" || assignment.status === "graded" || assignment.status === "excused";
}

function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const rank = (item: AttentionItem): number => (item.status === "missing" ? 0 : item.status === "late" ? 1 : 2);
  const bucket = rank(a) - rank(b);
  if (bucket !== 0) return bucket;
  const due = (item: AttentionItem): number => (item.due ? new Date(item.due).getTime() : Number.MAX_SAFE_INTEGER);
  const byDue = due(a) - due(b);
  if (byDue !== 0) return byDue;
  return a.title.localeCompare(b.title);
}

function pointsLabel(earned: number | null, possible: number | null): string | null {
  if (earned == null && possible == null) return null;
  const left = earned == null ? "—" : formatPercent(earned);
  const right = possible == null ? "—" : formatPercent(possible);
  return `${left}/${right}`;
}

function periodRank(period: string | null): number {
  const match = period?.match(/\d+/);
  return match ? Number(match[0]) : 99;
}
