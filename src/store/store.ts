import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planAlerts, type AlertEvent, type AlertRule } from "../alerts/engine.ts";
import {
  assignmentCanonical,
  assignmentIdFor,
  courseIdFor,
  courseKey,
  describeChange,
  gradeSnapshotIdFor,
  parseChange,
  parseSource,
  pointsEarned,
  pointsPossible,
  sameGrade,
  studentIdFor,
  type Change,
  type ChangeId,
  type CourseName,
  type GradeDraft,
  type HouseholdKey,
  type IsoInstant,
  type SchoolSnapshot,
  type Source,
  type SourceId,
  type StudentId,
} from "../domain/index.ts";
import { sha256 } from "../hash.ts";
import { SCHEMA_VERSION, ddl } from "./schema.ts";
import { numberOrNull, text, textOrNull, type SqlRow } from "./rows.ts";

export type ApplyResult = {
  readonly baseline: boolean;
  readonly changes: readonly Change[];
  readonly messages: readonly string[];
  readonly alerts: readonly AlertEvent[];
  readonly counts: {
    readonly students: number;
    readonly courses: number;
    readonly assignments: number;
    readonly grades: number;
    readonly changes: number;
  };
};

const DEFAULT_RULES: readonly AlertRule[] = [
  { kind: "grade_below", enabled: false, threshold: 70 },
  { kind: "missing_above", enabled: false, count: 3 },
  { kind: "grade_drop", enabled: false, points: 10 },
];

export class Store {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  hasReceipt(contentHash: string): boolean {
    return this.db.prepare("SELECT content_hash FROM ingest_receipts WHERE content_hash = ?").get(contentHash) !== undefined;
  }

  hasSource(source: Source): boolean {
    return this.db.prepare("SELECT source FROM source_fetches WHERE source = ?").get(source) !== undefined;
  }

  applySnapshot(snapshot: SchoolSnapshot, contentHash: string, filename: string): ApplyResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const baseline = !this.hasSource(snapshot.source);
      const changes: Change[] = [];
      for (const student of snapshot.students) this.upsertStudent(student.householdKey, student.displayName, student.schoolName, student.source, student.sourceId, snapshot.fetchedAt);
      for (const course of snapshot.courses) {
        this.upsertCourse(this.requireStudent(course.householdKey), course.name, course.teacher, course.period, course.source, course.sourceId, snapshot.fetchedAt);
      }
      const grades = [...snapshot.grades].sort((left, right) => (left.asOf < right.asOf ? -1 : left.asOf > right.asOf ? 1 : 0));
      for (const grade of grades) changes.push(...this.upsertGrade(grade, snapshot.fetchedAt, baseline));
      for (const assignment of snapshot.assignments) changes.push(...this.upsertAssignment(assignment, snapshot.fetchedAt, baseline));
      const missing = this.missingCounts();
      const alerts = planAlerts({ rules: this.rules(), changes, missing, at: snapshot.fetchedAt });
      for (const alert of alerts) {
        this.db
          .prepare("INSERT OR IGNORE INTO alert_events (id, kind, student_id, message, at, payload) VALUES (?, ?, ?, ?, ?, ?)")
          .run(alert.id, alert.kind, alert.studentId, alert.message, alert.at, alert.payload);
      }
      this.db
        .prepare("INSERT INTO ingest_receipts (content_hash, source, filename, ingested_at) VALUES (?, ?, ?, ?)")
        .run(contentHash, snapshot.source, filename, snapshot.fetchedAt);
      this.db
        .prepare(
          `INSERT INTO source_fetches (source, fetched_at) VALUES (?, ?)
           ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at
           WHERE excluded.fetched_at > source_fetches.fetched_at`,
        )
        .run(snapshot.source, snapshot.fetchedAt);
      this.db.exec("COMMIT");
      return {
        baseline,
        changes,
        messages: changes.map(describeChange),
        alerts,
        counts: {
          students: snapshot.students.length,
          courses: snapshot.courses.length,
          assignments: snapshot.assignments.length,
          grades: snapshot.grades.length,
          changes: changes.length,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rules(): AlertRule[] {
    return this.db
      .prepare("SELECT kind, enabled, config FROM alert_rules ORDER BY kind")
      .all()
      .map((row) => ruleFromRow(row));
  }

  saveRules(rules: readonly AlertRule[]): void {
    const update = this.db.prepare("UPDATE alert_rules SET enabled = ?, config = ? WHERE kind = ?");
    for (const rule of rules) {
      const config =
        rule.kind === "grade_below"
          ? { threshold: rule.threshold }
          : rule.kind === "missing_above"
            ? { count: rule.count }
            : { points: rule.points };
      update.run(rule.enabled ? 1 : 0, JSON.stringify(config), rule.kind);
    }
  }

  webhook(): { readonly url: string | null; readonly enabled: boolean } {
    const url = this.meta("webhook_url");
    return { url: url.length > 0 ? url : null, enabled: this.meta("webhook_enabled") === "1" };
  }

  setWebhook(url: string | null, enabled: boolean): void {
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'webhook_url'").run(url ?? "");
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'webhook_enabled'").run(enabled ? "1" : "0");
  }

  alerts(): AlertEvent[] {
    return this.db
      .prepare("SELECT id, kind, student_id, message, at, payload FROM alert_events ORDER BY at, id")
      .all()
      .map((row) => ({
        id: text(row, "id"),
        kind: text(row, "kind") as AlertEvent["kind"],
        studentId: text(row, "student_id"),
        message: text(row, "message"),
        at: text(row, "at") as IsoInstant,
        payload: text(row, "payload"),
      }));
  }

  changes(): Change[] {
    return this.db
      .prepare("SELECT payload FROM changes ORDER BY at, id")
      .all()
      .map((row) => parseChange(text(row, "payload")));
  }

  dump(): string {
    const tables = [
      "meta",
      "students",
      "student_sources",
      "courses",
      "course_sources",
      "assignments",
      "grade_snapshots",
      "changes",
      "ingest_receipts",
      "source_fetches",
      "alert_rules",
      "alert_events",
    ] as const;
    const payload: Record<string, SqlRow[]> = {};
    for (const table of tables) {
      payload[table] = this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    return JSON.stringify(payload);
  }

  private migrate(): void {
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!existing) {
      this.db.exec(ddl());
      const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insert.run("schema_version", String(SCHEMA_VERSION));
      insert.run("webhook_url", "");
      insert.run("webhook_enabled", "0");
      const rule = this.db.prepare("INSERT INTO alert_rules (kind, enabled, config) VALUES (?, 0, ?)");
      for (const item of DEFAULT_RULES) {
        const config =
          item.kind === "grade_below"
            ? { threshold: item.threshold }
            : item.kind === "missing_above"
              ? { count: item.count }
              : { points: item.points };
        rule.run(item.kind, JSON.stringify(config));
      }
      return;
    }
    const version = this.meta("schema_version");
    if (version !== String(SCHEMA_VERSION)) throw new Error(`unsupported schema version ${version}`);
  }

  private meta(key: string): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) throw new Error(`missing meta ${key}`);
    return text(row, "value");
  }

  private requireStudent(key: HouseholdKey): StudentId {
    const id = studentIdFor(key);
    const row = this.db.prepare("SELECT id FROM students WHERE id = ?").get(id);
    if (!row) throw new Error(`snapshot references ${key} before that student is declared`);
    return id;
  }

  private upsertStudent(
    key: HouseholdKey,
    displayName: string,
    schoolName: string | null,
    source: Source,
    sourceId: SourceId,
    fetchedAt: IsoInstant,
  ): void {
    const id = studentIdFor(key);
    this.db
      .prepare(
        `INSERT INTO students (id, household_key, display_name, school_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           school_name = COALESCE(excluded.school_name, students.school_name),
           updated_at = excluded.updated_at`,
      )
      .run(id, key, displayName, schoolName, fetchedAt, fetchedAt);
    this.db
      .prepare(
        `INSERT INTO student_sources (student_id, source, source_id, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, source_id) DO UPDATE SET fetched_at = excluded.fetched_at, student_id = excluded.student_id`,
      )
      .run(id, source, sourceId, fetchedAt);
  }

  private upsertCourse(
    studentId: StudentId,
    name: CourseName,
    teacher: string | null,
    period: string | null,
    source: Source,
    sourceId: SourceId,
    fetchedAt: IsoInstant,
  ): void {
    const id = courseIdFor(studentId, name);
    this.db
      .prepare(
        `INSERT INTO courses (id, student_id, name, name_key, teacher, period, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, name_key) DO UPDATE SET
           teacher = COALESCE(excluded.teacher, courses.teacher),
           period = COALESCE(excluded.period, courses.period),
           updated_at = excluded.updated_at`,
      )
      .run(id, studentId, name, courseKey(name), teacher, period, fetchedAt, fetchedAt);
    this.db
      .prepare(
        `INSERT INTO course_sources (course_id, source, source_id, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, source_id) DO UPDATE SET fetched_at = excluded.fetched_at, course_id = excluded.course_id`,
      )
      .run(id, source, sourceId, fetchedAt);
  }

  private ensureCourse(studentId: StudentId, name: CourseName, fetchedAt: IsoInstant): ReturnType<typeof courseIdFor> {
    const id = courseIdFor(studentId, name);
    this.db
      .prepare(
        `INSERT INTO courses (id, student_id, name, name_key, teacher, period, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(student_id, name_key) DO NOTHING`,
      )
      .run(id, studentId, name, courseKey(name), fetchedAt, fetchedAt);
    return id;
  }

  private upsertGrade(grade: GradeDraft, fetchedAt: IsoInstant, baseline: boolean): Change[] {
    const studentId = this.requireStudent(grade.householdKey);
    const courseId = this.ensureCourse(studentId, grade.courseName, fetchedAt);
    const id = gradeSnapshotIdFor(grade.source, grade.sourceId, grade.asOf);
    const existing = this.db
      .prepare("SELECT percent, letter FROM grade_snapshots WHERE source = ? AND source_id = ? AND as_of = ?")
      .get(grade.source, grade.sourceId, grade.asOf);
    const percent = grade.value.percent;
    const letter = grade.value.letter;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO grade_snapshots (id, student_id, course_id, source, source_id, percent, letter, as_of, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, studentId, courseId, grade.source, grade.sourceId, percent, letter, grade.asOf, fetchedAt);
    } else if (numberOrNull(existing, "percent") !== percent || textOrNull(existing, "letter") !== letter) {
      const fromPercent = numberOrNull(existing, "percent");
      const fromLetter = textOrNull(existing, "letter");
      this.db
        .prepare("UPDATE grade_snapshots SET percent = ?, letter = ?, fetched_at = ?, course_id = ?, student_id = ? WHERE id = ?")
        .run(percent, letter, fetchedAt, courseId, studentId, id);
      if (baseline || fromPercent === null && fromLetter === null) return [];
      const from = fromPercent === null ? { percent: null, letter: fromLetter } : { percent: fromPercent, letter: fromLetter };
      if (!from.letter && from.percent === null) return [];
      if (sameGrade(from as GradeDraft["value"], grade.value)) return [];
      return this.insertGradeChange(studentId, courseId, grade, from as GradeDraft["value"], grade.value);
    } else {
      return [];
    }
    if (baseline) return [];
    const previous = this.db
      .prepare(
        `SELECT percent, letter FROM grade_snapshots
         WHERE source = ? AND source_id = ? AND as_of < ?
         ORDER BY as_of DESC LIMIT 1`,
      )
      .get(grade.source, grade.sourceId, grade.asOf);
    if (!previous) return [];
    const fromPercent = numberOrNull(previous, "percent");
    const fromLetter = textOrNull(previous, "letter");
    if (fromPercent === null && fromLetter === null) return [];
    const from = fromPercent === null ? { percent: null as null, letter: fromLetter } : { percent: fromPercent, letter: fromLetter };
    if (from.letter === null && from.percent === null) return [];
    if (sameGrade(from as GradeDraft["value"], grade.value)) return [];
    return this.insertGradeChange(studentId, courseId, grade, from as GradeDraft["value"], grade.value);
  }

  private insertGradeChange(
    studentId: StudentId,
    courseId: ReturnType<typeof courseIdFor>,
    grade: GradeDraft,
    from: GradeDraft["value"],
    to: GradeDraft["value"],
  ): Change[] {
    const change: Change = {
      kind: "grade",
      id: changeId(["grade", grade.source, grade.sourceId, grade.asOf, String(from.percent), String(from.letter), String(to.percent), String(to.letter)]),
      studentId,
      courseId,
      courseName: grade.courseName,
      source: grade.source,
      from,
      to,
      at: grade.asOf,
    };
    return this.insertChange(change) ? [change] : [];
  }

  private upsertAssignment(draft: SchoolSnapshot["assignments"][number], fetchedAt: IsoInstant, baseline: boolean): Change[] {
    const studentId = this.requireStudent(draft.householdKey);
    const courseId = this.ensureCourse(studentId, draft.courseName, fetchedAt);
    const earned = pointsEarned(draft.points);
    const possible = pointsPossible(draft.points);
    const hash = sha256(assignmentCanonical(draft));
    const existing = this.db
      .prepare("SELECT status, earned, possible, content_hash FROM assignments WHERE source = ? AND source_id = ?")
      .get(draft.source, draft.sourceId);
    const id = assignmentIdFor(draft.source, draft.sourceId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO assignments (
            id, student_id, course_id, source, source_id, title, status, earned, possible, category, url,
            assigned_at, due_at, fetched_at, last_seen, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          studentId,
          courseId,
          draft.source,
          draft.sourceId,
          draft.title,
          draft.status,
          earned,
          possible,
          draft.category,
          draft.url,
          draft.assignedAt,
          draft.dueAt,
          fetchedAt,
          fetchedAt,
          hash,
        );
      if (baseline) return [];
      const change: Change = {
        kind: "assignment_new",
        id: changeId(["new", draft.source, draft.sourceId]),
        studentId,
        courseId,
        courseName: draft.courseName,
        assignmentId: id,
        title: draft.title,
        dueAt: draft.dueAt,
        source: draft.source,
        at: fetchedAt,
      };
      return this.insertChange(change) ? [change] : [];
    }
    this.db
      .prepare(
        `UPDATE assignments SET
          student_id = ?, course_id = ?, title = ?, status = ?, earned = ?, possible = ?, category = ?, url = ?,
          assigned_at = ?, due_at = ?, fetched_at = ?, last_seen = ?, content_hash = ?
         WHERE source = ? AND source_id = ?`,
      )
      .run(
        studentId,
        courseId,
        draft.title,
        draft.status,
        earned,
        possible,
        draft.category,
        draft.url,
        draft.assignedAt,
        draft.dueAt,
        fetchedAt,
        fetchedAt,
        hash,
        draft.source,
        draft.sourceId,
      );
    if (baseline || text(existing, "content_hash") === hash) return [];
    const previousStatus = text(existing, "status");
    const previousEarned = numberOrNull(existing, "earned");
    const previousPossible = numberOrNull(existing, "possible");
    if (previousStatus !== draft.status) {
      const change: Change = {
        kind: "assignment_status",
        id: changeId(["status", draft.source, draft.sourceId, previousStatus, draft.status, fetchedAt]),
        studentId,
        courseId,
        courseName: draft.courseName,
        assignmentId: id,
        title: draft.title,
        from: previousStatus as Change extends { kind: "assignment_status"; from: infer S } ? S : never,
        to: draft.status,
        source: draft.source,
        at: fetchedAt,
      };
      return this.insertChange(change) ? [change] : [];
    }
    if (previousEarned !== earned || previousPossible !== possible) {
      const change: Change = {
        kind: "assignment_score",
        id: changeId(["score", draft.source, draft.sourceId, String(previousEarned), String(earned), fetchedAt]),
        studentId,
        courseId,
        courseName: draft.courseName,
        assignmentId: id,
        title: draft.title,
        fromEarned: previousEarned,
        toEarned: earned,
        possible,
        source: draft.source,
        at: fetchedAt,
      };
      return this.insertChange(change) ? [change] : [];
    }
    return [];
  }

  private insertChange(change: Change): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO changes (id, kind, student_id, course_id, assignment_id, source, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        change.id,
        change.kind,
        change.studentId,
        change.courseId,
        "assignmentId" in change ? change.assignmentId : null,
        change.source,
        JSON.stringify(change),
        change.at,
      );
    return Number(result.changes) > 0;
  }

  private missingCounts(): { studentId: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT student_id, COUNT(*) AS count FROM assignments WHERE status = 'missing' GROUP BY student_id`,
      )
      .all()
      .map((row) => ({ studentId: text(row, "student_id"), count: numberOrNull(row, "count") ?? 0 }));
  }
}

function changeId(parts: readonly string[]): ChangeId {
  return `chg_${sha256(parts.join("|")).slice(0, 24)}` as ChangeId;
}

function ruleFromRow(row: SqlRow): AlertRule {
  const kind = text(row, "kind");
  const enabled = numberOrNull(row, "enabled") === 1;
  const config = JSON.parse(text(row, "config")) as Record<string, unknown>;
  if (kind === "grade_below" && typeof config["threshold"] === "number") {
    return { kind, enabled, threshold: config["threshold"] };
  }
  if (kind === "missing_above" && typeof config["count"] === "number") {
    return { kind, enabled, count: config["count"] };
  }
  if (kind === "grade_drop" && typeof config["points"] === "number") {
    return { kind, enabled, points: config["points"] };
  }
  throw new Error(`corrupt alert rule ${kind}`);
}

export function assertSource(value: string): Source {
  const parsed = parseSource(value);
  if (!parsed.ok) throw new Error(parsed.error.kind);
  return parsed.value;
}
