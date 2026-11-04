import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type {
  Alert,
  AlertRule,
  AlertRuleType,
  Assignment,
  AssignmentStatus,
  Change,
  ChangeKind,
  Course,
  GradeSnapshot,
  Student,
} from "../model/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('powerschool','onenote','google-classroom','generic')),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  school TEXT,
  grade_level TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  teacher TEXT,
  period TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL,
  due TEXT,
  assigned TEXT,
  status TEXT NOT NULL CHECK (status IN ('assigned','turned_in','graded','missing','late','excused')),
  points_earned REAL,
  points_possible REAL,
  category TEXT,
  url TEXT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  group_key TEXT,
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  UNIQUE(source, source_id),
  CHECK (points_possible IS NULL OR points_possible > 0),
  CHECK (points_earned IS NULL OR points_earned >= 0),
  CHECK (
    (status = 'graded' AND points_earned IS NOT NULL AND points_possible IS NOT NULL AND points_earned <= points_possible)
    OR (status = 'missing' AND points_earned = 0)
    OR (status = 'late' AND (points_earned IS NULL OR points_possible IS NULL OR points_earned <= points_possible))
    OR (status IN ('assigned', 'turned_in', 'excused') AND points_earned IS NULL)
  )
);
CREATE TABLE IF NOT EXISTS grade_snapshots (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  percent REAL,
  letter TEXT,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
  CHECK (letter IS NULL OR letter IN ('A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F')),
  CHECK (percent IS NOT NULL OR letter IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  student_id TEXT,
  course_id TEXT,
  assignment_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  before TEXT,
  after TEXT,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  type TEXT NOT NULL,
  threshold REAL NOT NULL,
  student_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due);
CREATE INDEX IF NOT EXISTS idx_grades_course ON grade_snapshots(course_id, as_of);
CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // memory databases ignore WAL
  }
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw error;
  }
}

type Row = Record<string, SQLOutputValue>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected text in ${key}`);
  return value;
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`Expected text in ${key}`);
  return value;
}

function numberOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Expected number in ${key}`);
}

function mapStudent(row: Row): Student {
  return {
    id: text(row, "id"),
    source: text(row, "source"),
    sourceId: text(row, "source_id"),
    name: text(row, "name"),
    school: textOrNull(row, "school"),
    gradeLevel: textOrNull(row, "grade_level"),
    fetchedAt: text(row, "fetched_at"),
  };
}

function mapCourse(row: Row): Course {
  return {
    id: text(row, "id"),
    studentId: text(row, "student_id"),
    source: text(row, "source"),
    sourceId: text(row, "source_id"),
    name: text(row, "name"),
    teacher: textOrNull(row, "teacher"),
    period: textOrNull(row, "period"),
    fetchedAt: text(row, "fetched_at"),
  };
}

function mapAssignment(row: Row): Assignment {
  return {
    id: text(row, "id"),
    studentId: text(row, "student_id"),
    courseId: text(row, "course_id"),
    title: text(row, "title"),
    due: textOrNull(row, "due"),
    assigned: textOrNull(row, "assigned"),
    status: text(row, "status") as AssignmentStatus,
    pointsEarned: numberOrNull(row, "points_earned"),
    pointsPossible: numberOrNull(row, "points_possible"),
    category: textOrNull(row, "category"),
    url: textOrNull(row, "url"),
    source: text(row, "source"),
    sourceId: text(row, "source_id"),
    lastSeen: text(row, "last_seen"),
    fetchedAt: text(row, "fetched_at"),
    groupKey: textOrNull(row, "group_key"),
    removed: Number(row["removed"] ?? 0) === 1,
  };
}

function mapGrade(row: Row): GradeSnapshot {
  return {
    id: text(row, "id"),
    studentId: text(row, "student_id"),
    courseId: text(row, "course_id"),
    percent: numberOrNull(row, "percent"),
    letter: textOrNull(row, "letter"),
    asOf: text(row, "as_of"),
    source: text(row, "source"),
    fetchedAt: text(row, "fetched_at"),
  };
}

function mapChange(row: Row): Change {
  return {
    id: text(row, "id"),
    studentId: textOrNull(row, "student_id"),
    courseId: textOrNull(row, "course_id"),
    assignmentId: textOrNull(row, "assignment_id"),
    kind: text(row, "kind") as ChangeKind,
    summary: text(row, "summary"),
    before: textOrNull(row, "before"),
    after: textOrNull(row, "after"),
    source: text(row, "source"),
    fetchedAt: text(row, "fetched_at"),
    createdAt: text(row, "created_at"),
  };
}

function mapRule(row: Row): AlertRule {
  return {
    id: text(row, "id"),
    enabled: numberOrNull(row, "enabled") === 1,
    type: text(row, "type") as AlertRuleType,
    threshold: numberOrNull(row, "threshold") ?? 0,
    studentName: textOrNull(row, "student_name"),
    createdAt: text(row, "created_at"),
  };
}

function mapAlert(row: Row): Alert {
  return {
    id: text(row, "id"),
    ruleId: text(row, "rule_id"),
    summary: text(row, "summary"),
    dedupeKey: text(row, "dedupe_key"),
    createdAt: text(row, "created_at"),
    source: text(row, "source"),
  };
}

export function getStudentBySource(db: DatabaseSync, source: string, sourceId: string): Student | null {
  const row = db.prepare("SELECT * FROM students WHERE source = ? AND source_id = ?").get(source, sourceId);
  return row ? mapStudent(row) : null;
}

export function insertStudent(db: DatabaseSync, student: Omit<Student, "id">): Student {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO students (id, source, source_id, name, school, grade_level, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, student.source, student.sourceId, student.name, student.school, student.gradeLevel, student.fetchedAt);
  return { ...student, id };
}

export function updateStudent(db: DatabaseSync, student: Student): void {
  db.prepare(
    `UPDATE students SET name = ?, school = ?, grade_level = ?, fetched_at = ? WHERE id = ?`,
  ).run(student.name, student.school, student.gradeLevel, student.fetchedAt, student.id);
}

export function listStudents(db: DatabaseSync): Student[] {
  return db.prepare("SELECT * FROM students ORDER BY name, source").all().map(mapStudent);
}

export function getCourseBySource(db: DatabaseSync, source: string, sourceId: string): Course | null {
  const row = db.prepare("SELECT * FROM courses WHERE source = ? AND source_id = ?").get(source, sourceId);
  return row ? mapCourse(row) : null;
}

export function insertCourse(db: DatabaseSync, course: Omit<Course, "id">): Course {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO courses (id, student_id, source, source_id, name, teacher, period, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, course.studentId, course.source, course.sourceId, course.name, course.teacher, course.period, course.fetchedAt);
  return { ...course, id };
}

export function updateCourse(db: DatabaseSync, course: Course): void {
  db.prepare(
    `UPDATE courses SET student_id = ?, name = ?, teacher = ?, period = ?, fetched_at = ? WHERE id = ?`,
  ).run(course.studentId, course.name, course.teacher, course.period, course.fetchedAt, course.id);
}

export function listCourses(db: DatabaseSync): Course[] {
  return db.prepare("SELECT * FROM courses ORDER BY name").all().map(mapCourse);
}

export function getAssignmentBySource(db: DatabaseSync, source: string, sourceId: string): Assignment | null {
  const row = db.prepare("SELECT * FROM assignments WHERE source = ? AND source_id = ?").get(source, sourceId);
  return row ? mapAssignment(row) : null;
}

export function insertAssignment(db: DatabaseSync, assignment: Omit<Assignment, "id">): Assignment {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO assignments (
      id, student_id, course_id, title, due, assigned, status, points_earned, points_possible,
      category, url, source, source_id, last_seen, fetched_at, group_key, removed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    assignment.studentId,
    assignment.courseId,
    assignment.title,
    assignment.due,
    assignment.assigned,
    assignment.status,
    assignment.pointsEarned,
    assignment.pointsPossible,
    assignment.category,
    assignment.url,
    assignment.source,
    assignment.sourceId,
    assignment.lastSeen,
    assignment.fetchedAt,
    assignment.groupKey,
    assignment.removed ? 1 : 0,
  );
  return { ...assignment, id };
}

export function updateAssignment(db: DatabaseSync, assignment: Assignment): void {
  db.prepare(
    `UPDATE assignments SET
      student_id = ?, course_id = ?, title = ?, due = ?, assigned = ?, status = ?,
      points_earned = ?, points_possible = ?, category = ?, url = ?, last_seen = ?, fetched_at = ?,
      group_key = ?, removed = ?
     WHERE id = ?`,
  ).run(
    assignment.studentId,
    assignment.courseId,
    assignment.title,
    assignment.due,
    assignment.assigned,
    assignment.status,
    assignment.pointsEarned,
    assignment.pointsPossible,
    assignment.category,
    assignment.url,
    assignment.lastSeen,
    assignment.fetchedAt,
    assignment.groupKey,
    assignment.removed ? 1 : 0,
    assignment.id,
  );
}

export function listAssignments(db: DatabaseSync): Assignment[] {
  return db.prepare("SELECT * FROM assignments ORDER BY due, title").all().map(mapAssignment);
}

export function countAssignmentsBySource(db: DatabaseSync, source: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE source = ?").get(source);
  return row ? Number(numberOrNull(row, "n") ?? 0) : 0;
}

export function countAssignmentsForStudent(db: DatabaseSync, source: string, studentId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE source = ? AND student_id = ?").get(source, studentId);
  return row ? Number(numberOrNull(row, "n") ?? 0) : 0;
}

export function listGrades(db: DatabaseSync): GradeSnapshot[] {
  return db.prepare("SELECT * FROM grade_snapshots ORDER BY as_of").all().map(mapGrade);
}

export function listGradesForCourse(db: DatabaseSync, courseId: string): GradeSnapshot[] {
  return db.prepare("SELECT * FROM grade_snapshots WHERE course_id = ? ORDER BY as_of, id").all(courseId).map(mapGrade);
}

export function getGradeAt(db: DatabaseSync, courseId: string, asOf: string): GradeSnapshot | null {
  const row = db.prepare("SELECT * FROM grade_snapshots WHERE course_id = ? AND as_of = ? ORDER BY id DESC LIMIT 1").get(courseId, asOf);
  return row ? mapGrade(row) : null;
}

export function latestGrade(db: DatabaseSync, courseId: string): GradeSnapshot | null {
  const row = db.prepare("SELECT * FROM grade_snapshots WHERE course_id = ? ORDER BY as_of DESC, id DESC LIMIT 1").get(courseId);
  return row ? mapGrade(row) : null;
}

export function insertGrade(db: DatabaseSync, grade: Omit<GradeSnapshot, "id">): GradeSnapshot {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO grade_snapshots (id, student_id, course_id, percent, letter, as_of, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, grade.studentId, grade.courseId, grade.percent, grade.letter, grade.asOf, grade.source, grade.fetchedAt);
  return { ...grade, id };
}

export function updateGrade(db: DatabaseSync, grade: GradeSnapshot): void {
  db.prepare(
    `UPDATE grade_snapshots SET percent = ?, letter = ?, fetched_at = ? WHERE id = ?`,
  ).run(grade.percent, grade.letter, grade.fetchedAt, grade.id);
}

export function insertChange(db: DatabaseSync, change: Omit<Change, "id"> & { id?: string }): Change {
  const id = change.id ?? randomUUID();
  db.prepare(
    `INSERT INTO changes (
      id, student_id, course_id, assignment_id, kind, summary, before, after, source, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    change.studentId,
    change.courseId,
    change.assignmentId,
    change.kind,
    change.summary,
    change.before,
    change.after,
    change.source,
    change.fetchedAt,
    change.createdAt,
  );
  return { ...change, id };
}

export function listChanges(db: DatabaseSync): Change[] {
  return db.prepare("SELECT * FROM changes ORDER BY created_at DESC, id DESC").all().map(mapChange);
}

export function listRules(db: DatabaseSync): AlertRule[] {
  return db.prepare("SELECT * FROM alert_rules ORDER BY created_at").all().map(mapRule);
}

export function replaceRules(db: DatabaseSync, rules: Array<Omit<AlertRule, "id" | "createdAt"> & { id?: string }>, now: Date): AlertRule[] {
  db.exec("DELETE FROM alert_rules");
  const saved: AlertRule[] = [];
  for (const rule of rules) {
    const stored: AlertRule = {
      id: rule.id || randomUUID(),
      enabled: rule.enabled,
      type: rule.type,
      threshold: rule.threshold,
      studentName: rule.studentName,
      createdAt: now.toISOString(),
    };
    db.prepare(
      `INSERT INTO alert_rules (id, enabled, type, threshold, student_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stored.id, stored.enabled ? 1 : 0, stored.type, stored.threshold, stored.studentName, stored.createdAt);
    saved.push(stored);
  }
  return saved;
}

export function listAlerts(db: DatabaseSync): Alert[] {
  return db.prepare("SELECT * FROM alerts ORDER BY created_at DESC").all().map(mapAlert);
}

export function alertExists(db: DatabaseSync, dedupeKey: string): boolean {
  const row = db.prepare("SELECT id FROM alerts WHERE dedupe_key = ?").get(dedupeKey);
  return Boolean(row);
}

export function insertAlert(db: DatabaseSync, alert: Omit<Alert, "id">): Alert {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO alerts (id, rule_id, summary, dedupe_key, created_at, source) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, alert.ruleId, alert.summary, alert.dedupeKey, alert.createdAt, alert.source);
  return { ...alert, id };
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? text(row, "value") : null;
}

export function setSetting(db: DatabaseSync, key: string, value: string | null): void {
  if (value == null || value === "") {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
