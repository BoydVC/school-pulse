import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { formatPercent, isStale, termRank, weekdayShort } from './dates.js';
import type { ParsedAssignment, ParsedBatch, ParsedGrade, Source } from './model.js';
import { SOURCE_LABEL } from './model.js';
import { sha256, shortHash, slug, studentIdForName } from './text.js';

export interface ApplyResult {
  changes: ChangeRow[];
  inserted: number;
  updated: number;
  refreshed: number;
  dropped: number;
  unchanged: number;
}

export interface ChangeRow {
  id: string;
  studentId: string | null;
  studentName: string | null;
  source: Source;
  kind: string;
  summary: string;
  courseName: string | null;
  at: string;
}

export interface DashboardState {
  now: string;
  staleHours: number;
  students: DashboardStudent[];
  assignments: DashboardAssignment[];
  changes: ChangeRow[];
  freshness: Freshness[];
  alertsEnabled: boolean;
}

export interface DashboardStudent {
  id: string;
  name: string;
  school: string;
  sources: Source[];
  dueToday: number;
  dueThisWeek: number;
  missing: number;
  late: number;
  courses: DashboardCourse[];
}

export interface DashboardCourse {
  id: string;
  name: string;
  teacher: string | null;
  period: string | null;
  term: string | null;
  source: Source;
  percent: number | null;
  letter: string | null;
  trend: number[];
  terms: { term: string | null; percent: number | null; letter: string | null }[];
  categories: { name: string; weight: number }[];
  url: string | null;
}

export interface DashboardAssignment {
  id: string;
  studentId: string;
  studentName: string;
  courseName: string;
  title: string;
  due: string | null;
  assigned: string | null;
  status: string;
  pointsEarned: number | null;
  pointsPossible: number | null;
  category: string | null;
  categoryWeight: number | null;
  url: string | null;
  source: Source;
  term: string | null;
  dropped: boolean;
}

export interface Freshness {
  source: Source;
  fetchedAt: string | null;
  stale: boolean;
  label: string;
}

interface AssignmentRow {
  id: string;
  student_id: string;
  course_id: string;
  title: string;
  course_name: string;
  due: string | null;
  assigned: string | null;
  status: string;
  points_earned: number | null;
  points_possible: number | null;
  category: string | null;
  category_weight: number | null;
  url: string | null;
  source: Source;
  source_id: string;
  term: string | null;
  dropped: number;
  group_key: string;
  last_seen: string;
  fetched_at: string;
  content_hash: string;
}

interface GradeSnap {
  percent: number | null;
  letter: string | null;
  term: string | null;
  as_of: string;
  current: number;
}

function assignmentHash(assignment: ParsedAssignment): string {
  return sha256(JSON.stringify({
    title: assignment.title,
    courseName: assignment.courseName,
    due: assignment.due,
    assigned: assignment.assigned,
    status: assignment.status,
    pointsEarned: assignment.pointsEarned,
    pointsPossible: assignment.pointsPossible,
    category: assignment.category,
    categoryWeight: assignment.categoryWeight,
    url: assignment.url,
    term: assignment.term,
    dropped: assignment.dropped,
    groupKey: assignment.groupKey,
    courseSourceId: assignment.courseSourceId,
  }));
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        school TEXT NOT NULL DEFAULT '',
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS student_sources (
        student_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (source, source_id)
      );
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        name TEXT NOT NULL,
        teacher TEXT,
        period TEXT,
        term TEXT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT,
        categories_json TEXT NOT NULL DEFAULT '[]',
        fetched_at TEXT NOT NULL,
        UNIQUE (source, source_id, student_id)
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        title TEXT NOT NULL,
        course_name TEXT NOT NULL,
        due TEXT,
        assigned TEXT,
        status TEXT NOT NULL,
        points_earned REAL,
        points_possible REAL,
        category TEXT,
        category_weight REAL,
        url TEXT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        term TEXT,
        dropped INTEGER NOT NULL DEFAULT 0,
        group_key TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE (source, source_id)
      );
      CREATE TABLE IF NOT EXISTS grade_snapshots (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        course_name TEXT NOT NULL,
        percent REAL,
        letter TEXT,
        term TEXT,
        as_of TEXT NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        current INTEGER NOT NULL DEFAULT 0,
        UNIQUE (course_id, term, percent, letter, as_of, current)
      );
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,
        student_id TEXT,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        course_name TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingest_log (
        fingerprint TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        threshold REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        webhook TEXT,
        student_id TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  hasFingerprint(fingerprint: string): boolean {
    const row = this.db.prepare('SELECT fingerprint FROM ingest_log WHERE fingerprint = ?').get(fingerprint) as { fingerprint: string } | undefined;
    return Boolean(row);
  }

  rememberFingerprint(fingerprint: string, source: Source, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO ingest_log (fingerprint, source, ingested_at) VALUES (?, ?, ?)').run(fingerprint, source, at);
  }

  apply(batch: ParsedBatch): ApplyResult {
    const changes: ChangeRow[] = [];
    let inserted = 0;
    let updated = 0;
    let refreshed = 0;
    let dropped = 0;
    let unchanged = 0;
    const sourceMax = this.maxFetched(batch.source);
    const historical = sourceMax !== null && batch.fetchedAt < sourceMax;

    this.db.exec('BEGIN');
    try {
      const studentIds = new Map<string, string>();
      for (const student of batch.students) {
        const id = this.upsertStudent(student.name, student.school, batch.source, student.sourceId, batch.fetchedAt, historical);
        studentIds.set(student.sourceId, id);
      }
      const courseIds = new Map<string, string>();
      for (const course of batch.courses) {
        const studentId = studentIds.get(course.studentSourceId);
        if (!studentId) continue;
        const id = this.upsertCourse(course, studentId, batch, historical);
        courseIds.set(`${course.studentSourceId}::${course.sourceId}`, id);
      }
      const gradeBefore = new Map<string, GradeSnap | null>();
      for (const id of courseIds.values()) gradeBefore.set(id, this.displayedGrade(id));

      for (const assignment of batch.assignments) {
        const studentId = studentIds.get(assignment.studentSourceId);
        const courseId = courseIds.get(`${assignment.studentSourceId}::${assignment.courseSourceId}`);
        if (!studentId || !courseId) continue;
        const outcome = this.upsertAssignment(assignment, studentId, courseId, batch, historical);
        if (outcome === 'insert') {
          inserted += 1;
          if (!assignment.dropped) {
            const summary = arrivalSummary(assignment);
            changes.push(this.addChange(studentId, batch, 'assignment_new', summary, assignment.courseName));
          }
        } else if (outcome === 'update') {
          updated += 1;
          const summary = updateSummary(assignment);
          if (summary) changes.push(this.addChange(studentId, batch, 'assignment_status', summary, assignment.courseName));
        } else if (outcome === 'refresh') refreshed += 1;
        else unchanged += 1;
      }

      if (!historical) {
        for (const group of batch.replaceGroups) {
          const incoming = new Set(batch.assignments.filter((item) => item.groupKey === group).map((item) => item.sourceId));
          const rows = this.db.prepare(
            'SELECT * FROM assignments WHERE group_key = ? AND dropped = 0 AND source = ?',
          ).all(group, batch.source) as unknown as AssignmentRow[];
          for (const row of rows) {
            if (incoming.has(row.source_id)) continue;
            if (row.fetched_at > batch.fetchedAt) continue;
            this.db.prepare(
              `UPDATE assignments SET dropped = 1, status = 'assigned', fetched_at = ?, last_seen = ?, content_hash = ? WHERE id = ?`,
            ).run(batch.fetchedAt, batch.fetchedAt, sha256(`${row.content_hash}:dropped`), row.id);
            dropped += 1;
            changes.push(this.addChange(row.student_id, batch, 'assignment_dropped', `${row.title} was dropped`, row.course_name));
          }
        }
      }

      for (const grade of batch.grades) {
        const courseId = courseIds.get(`${grade.studentSourceId}::${grade.courseSourceId}`);
        const studentId = studentIds.get(grade.studentSourceId);
        if (!courseId || !studentId) continue;
        this.insertGrade(grade, studentId, courseId, batch);
      }
      for (const [courseId, before] of gradeBefore) {
        const after = this.displayedGrade(courseId);
        if (!before || !after) continue;
        if (before.percent === after.percent && before.letter === after.letter && before.term === after.term) continue;
        const course = this.db.prepare('SELECT name, student_id FROM courses WHERE id = ?').get(courseId) as { name: string; student_id: string } | undefined;
        if (!course) continue;
        const from = formatPercent(before.percent) ?? before.letter ?? '—';
        const to = formatPercent(after.percent) ?? after.letter ?? '—';
        if (from === to) continue;
        changes.push(this.addChange(course.student_id, batch, 'grade', `${course.name} went from ${from} to ${to}`, course.name));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { changes, inserted, updated, refreshed, dropped, unchanged };
  }

  private maxFetched(source: Source): string | null {
    const row = this.db.prepare('SELECT MAX(fetched_at) AS fetched_at FROM assignments WHERE source = ?').get(source) as { fetched_at: string | null } | undefined;
    return row?.fetched_at ?? null;
  }

  private upsertStudent(name: string, school: string, source: Source, sourceId: string, fetchedAt: string, historical: boolean): string {
    const nameKey = slug(name);
    const existing = this.db.prepare('SELECT * FROM students WHERE name_key = ?').get(nameKey) as { id: string; school: string; fetched_at: string } | undefined;
    let id: string;
    if (!existing) {
      id = studentIdForName(name);
      this.db.prepare('INSERT INTO students (id, name, name_key, school, fetched_at) VALUES (?, ?, ?, ?, ?)').run(id, name, nameKey, school, fetchedAt);
    } else {
      id = existing.id;
      if (!historical && fetchedAt >= existing.fetched_at) {
        const nextSchool = existing.school || school;
        this.db.prepare('UPDATE students SET school = ?, fetched_at = ? WHERE id = ?').run(nextSchool, fetchedAt, id);
      }
    }
    this.db.prepare(
      `INSERT INTO student_sources (student_id, source, source_id, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, source_id) DO UPDATE SET
         student_id = excluded.student_id,
         fetched_at = CASE WHEN excluded.fetched_at > student_sources.fetched_at THEN excluded.fetched_at ELSE student_sources.fetched_at END`,
    ).run(id, source, sourceId, fetchedAt);
    return id;
  }

  private upsertCourse(course: ParsedBatch['courses'][number], studentId: string, batch: ParsedBatch, historical: boolean): string {
    const id = `course:${studentId}:${batch.source}:${course.sourceId}`;
    const categories = JSON.stringify(course.categories);
    const existing = this.db.prepare('SELECT id, fetched_at FROM courses WHERE id = ?').get(id) as { id: string; fetched_at: string } | undefined;
    if (!existing) {
      this.db.prepare(
        `INSERT INTO courses (id, student_id, name, teacher, period, term, source, source_id, url, categories_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, studentId, course.name, course.teacher, course.period, course.term, batch.source, course.sourceId, course.url, categories, batch.fetchedAt);
    } else if (!historical && batch.fetchedAt >= existing.fetched_at) {
      this.db.prepare(
        `UPDATE courses SET name = ?, teacher = ?, period = ?, term = ?, url = ?, categories_json = ?, fetched_at = ? WHERE id = ?`,
      ).run(course.name, course.teacher, course.period, course.term, course.url, categories, batch.fetchedAt, id);
    }
    return id;
  }

  private upsertAssignment(
    assignment: ParsedAssignment,
    studentId: string,
    courseId: string,
    batch: ParsedBatch,
    historical: boolean,
  ): 'insert' | 'update' | 'refresh' | 'unchanged' {
    const hash = assignmentHash(assignment);
    const existing = this.db.prepare('SELECT * FROM assignments WHERE source = ? AND source_id = ?').get(batch.source, assignment.sourceId) as AssignmentRow | undefined;
    if (!existing) {
      const id = `asmt:${batch.source}:${assignment.sourceId}`;
      this.db.prepare(
        `INSERT INTO assignments (
          id, student_id, course_id, title, course_name, due, assigned, status, points_earned, points_possible,
          category, category_weight, url, source, source_id, term, dropped, group_key, last_seen, fetched_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, studentId, courseId, assignment.title, assignment.courseName, assignment.due, assignment.assigned,
        assignment.status, assignment.pointsEarned, assignment.pointsPossible, assignment.category, assignment.categoryWeight,
        assignment.url, batch.source, assignment.sourceId, assignment.term, assignment.dropped ? 1 : 0, assignment.groupKey,
        batch.fetchedAt, batch.fetchedAt, hash,
      );
      return 'insert';
    }
    if (historical && batch.fetchedAt < existing.fetched_at) return 'unchanged';
    if (existing.content_hash === hash) {
      if (batch.fetchedAt > existing.fetched_at) {
        this.db.prepare('UPDATE assignments SET fetched_at = ?, last_seen = ? WHERE id = ?').run(batch.fetchedAt, batch.fetchedAt, existing.id);
        return 'refresh';
      }
      return 'unchanged';
    }
    const previousStatus = existing.status;
    this.db.prepare(
      `UPDATE assignments SET student_id = ?, course_id = ?, title = ?, course_name = ?, due = ?, assigned = ?, status = ?,
        points_earned = ?, points_possible = ?, category = ?, category_weight = ?, url = ?, term = ?, dropped = ?,
        group_key = ?, last_seen = ?, fetched_at = ?, content_hash = ? WHERE id = ?`,
    ).run(
      studentId, courseId, assignment.title, assignment.courseName, assignment.due, assignment.assigned, assignment.status,
      assignment.pointsEarned, assignment.pointsPossible, assignment.category, assignment.categoryWeight, assignment.url,
      assignment.term, assignment.dropped ? 1 : 0, assignment.groupKey, batch.fetchedAt, batch.fetchedAt, hash, existing.id,
    );
    (assignment as ParsedAssignment & { previousStatus?: string }).previousStatus = previousStatus;
    return 'update';
  }

  private insertGrade(grade: ParsedGrade, studentId: string, courseId: string, batch: ParsedBatch): void {
    const id = `grade:${shortHash(`${courseId}|${grade.term}|${grade.percent}|${grade.letter}|${grade.asOf}|${grade.current}`)}`;
    this.db.prepare(
      `INSERT OR IGNORE INTO grade_snapshots
        (id, student_id, course_id, course_name, percent, letter, term, as_of, source, fetched_at, current)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, studentId, courseId, grade.courseName, grade.percent, grade.letter, grade.term, grade.asOf,
      batch.source, batch.fetchedAt, grade.current ? 1 : 0,
    );
  }

  private displayedGrade(courseId: string): GradeSnap | null {
    const row = this.db.prepare(
      `SELECT percent, letter, term, as_of, current FROM grade_snapshots
       WHERE course_id = ? AND current = 1
       ORDER BY as_of DESC, term DESC LIMIT 1`,
    ).get(courseId) as GradeSnap | undefined;
    return row ?? null;
  }

  private addChange(studentId: string, batch: ParsedBatch, kind: string, summary: string, courseName: string | null): ChangeRow {
    const at = batch.fetchedAt;
    const id = `chg:${shortHash(`${batch.source}|${kind}|${summary}|${at}|${studentId}`)}`;
    this.db.prepare(
      'INSERT OR IGNORE INTO changes (id, student_id, source, kind, summary, course_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, studentId, batch.source, kind, summary, courseName, at);
    const student = this.db.prepare('SELECT name FROM students WHERE id = ?').get(studentId) as { name: string } | undefined;
    return { id, studentId, studentName: student?.name ?? null, source: batch.source, kind, summary, courseName, at };
  }

  snapshot(): string {
    const students = this.db.prepare('SELECT id, name, school FROM students ORDER BY id').all();
    const courses = this.db.prepare('SELECT id, name, term, source, categories_json FROM courses ORDER BY id').all();
    const assignments = this.db.prepare(
      'SELECT source, source_id, title, status, due, points_earned, points_possible, dropped, term FROM assignments ORDER BY source_id',
    ).all();
    const grades = this.db.prepare(
      'SELECT course_name, percent, letter, term, as_of, current FROM grade_snapshots ORDER BY as_of, course_name, term',
    ).all();
    const changes = this.db.prepare('SELECT kind, summary FROM changes ORDER BY at, summary').all();
    return JSON.stringify({ students, courses, assignments, grades, changes });
  }

  state(now = new Date(), staleHours = 36): DashboardState {
    const today = now.toISOString().slice(0, 10);
    const day = now.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = shift(today, mondayOffset);
    const end = shift(start, 6);
    const students = this.db.prepare('SELECT * FROM students ORDER BY name').all() as {
      id: string; name: string; school: string;
    }[];
    const dashboardStudents: DashboardStudent[] = students.map((student) => {
      const sources = (this.db.prepare(
        'SELECT DISTINCT source FROM student_sources WHERE student_id = ? ORDER BY source',
      ).all(student.id) as { source: Source }[]).map((row) => row.source);
      const courses = this.coursesFor(student.id);
      const assignments = this.assignmentsFor(student.id);
      const active = assignments.filter((item) => !item.dropped && item.status !== 'excused');
      return {
        id: student.id,
        name: student.name,
        school: student.school,
        sources,
        dueToday: active.filter((item) => item.due === today).length,
        dueThisWeek: active.filter((item) => item.due !== null && item.due >= start && item.due <= end).length,
        missing: assignments.filter((item) => !item.dropped && item.status === 'missing').length,
        late: assignments.filter((item) => !item.dropped && item.status === 'late').length,
        courses,
      };
    });
    const rules = this.db.prepare('SELECT enabled FROM alert_rules').all() as { enabled: number }[];
    return {
      now: now.toISOString(),
      staleHours,
      students: dashboardStudents,
      assignments: this.allAssignments(),
      changes: this.recentChanges(),
      freshness: this.freshness(now, staleHours),
      alertsEnabled: rules.some((rule) => rule.enabled === 1),
    };
  }

  private coursesFor(studentId: string): DashboardCourse[] {
    const rows = this.db.prepare('SELECT * FROM courses WHERE student_id = ? ORDER BY name, source').all(studentId) as {
      id: string; name: string; teacher: string | null; period: string | null; term: string | null;
      source: Source; url: string | null; categories_json: string;
    }[];
    return rows.map((row) => {
      const snaps = this.db.prepare(
        'SELECT percent, letter, term, as_of, current FROM grade_snapshots WHERE course_id = ? ORDER BY as_of ASC',
      ).all(row.id) as unknown as GradeSnap[];
      const displayed = [...snaps].reverse().find((snap) => snap.current === 1) ?? null;
      const trend = snaps.filter((snap) => snap.current === 1 && snap.percent !== null).map((snap) => snap.percent as number);
      const terms = new Map<string, GradeSnap>();
      for (const snap of snaps) {
        if (!snap.term) continue;
        const prev = terms.get(snap.term);
        if (!prev || snap.as_of >= prev.as_of) terms.set(snap.term, snap);
      }
      return {
        id: row.id,
        name: row.name,
        teacher: row.teacher,
        period: row.period,
        term: displayed?.term ?? row.term,
        source: row.source,
        percent: displayed?.percent ?? null,
        letter: displayed?.letter ?? null,
        trend,
        terms: [...terms.values()]
          .sort((a, b) => termRank(a.term) - termRank(b.term))
          .map((snap) => ({ term: snap.term, percent: snap.percent, letter: snap.letter })),
        categories: JSON.parse(row.categories_json) as { name: string; weight: number }[],
        url: row.url,
      };
    });
  }

  private assignmentsFor(studentId: string): DashboardAssignment[] {
    return this.allAssignments().filter((item) => item.studentId === studentId);
  }

  private allAssignments(): DashboardAssignment[] {
    const rows = this.db.prepare(
      `SELECT a.*, s.name AS student_name FROM assignments a
       JOIN students s ON s.id = a.student_id
       ORDER BY a.due IS NULL, a.due, a.title`,
    ).all() as unknown as (AssignmentRow & { student_name: string })[];
    return rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      courseName: row.course_name,
      title: row.title,
      due: row.due,
      assigned: row.assigned,
      status: row.status,
      pointsEarned: row.points_earned,
      pointsPossible: row.points_possible,
      category: row.category,
      categoryWeight: row.category_weight,
      url: row.url,
      source: row.source,
      term: row.term,
      dropped: row.dropped === 1,
    }));
  }

  private recentChanges(limit = 40): ChangeRow[] {
    const rows = this.db.prepare(
      `SELECT c.*, s.name AS student_name FROM changes c
       LEFT JOIN students s ON s.id = c.student_id
       ORDER BY c.at DESC, c.summary DESC LIMIT ?`,
    ).all(limit) as {
      id: string; student_id: string | null; student_name: string | null; source: Source;
      kind: string; summary: string; course_name: string | null; at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      source: row.source,
      kind: row.kind,
      summary: row.summary,
      courseName: row.course_name,
      at: row.at,
    }));
  }

  private freshness(now: Date, staleHours: number): Freshness[] {
    const sources: Source[] = ['powerschool', 'onenote', 'google-classroom', 'generic'];
    return sources.map((source) => {
      const row = this.db.prepare('SELECT MAX(fetched_at) AS fetched_at FROM student_sources WHERE source = ?').get(source) as { fetched_at: string | null } | undefined;
      const fetchedAt = row?.fetched_at ?? null;
      if (!fetchedAt) return { source, fetchedAt: null, stale: false, label: `${SOURCE_LABEL[source]} not connected` };
      const stale = isStale(fetchedAt, now, staleHours);
      const relative = relativeLabel(fetchedAt, now);
      return { source, fetchedAt, stale, label: `${SOURCE_LABEL[source]} ${relative}${stale ? ' · stale' : ''}` };
    });
  }

  listAlertRules(): AlertRule[] {
    return this.db.prepare('SELECT * FROM alert_rules ORDER BY id').all() as unknown as AlertRule[];
  }

  saveAlertRules(rules: AlertRule[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM alert_rules');
      const insert = this.db.prepare(
        'INSERT INTO alert_rules (id, kind, threshold, enabled, webhook, student_id) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const rule of rules) {
        insert.run(rule.id, rule.kind, rule.threshold, rule.enabled ? 1 : 0, rule.webhook, rule.student_id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordAlert(event: { id: string; ruleId: string; summary: string; payload: unknown; at: string; delivered: boolean }): void {
    this.db.prepare(
      'INSERT INTO alert_events (id, rule_id, summary, payload_json, at, delivered) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(event.id, event.ruleId, event.summary, JSON.stringify(event.payload), event.at, event.delivered ? 1 : 0);
  }

  listAlertEvents(): { id: string; rule_id: string; summary: string; at: string; delivered: number }[] {
    return this.db.prepare('SELECT id, rule_id, summary, at, delivered FROM alert_events ORDER BY at DESC').all() as {
      id: string; rule_id: string; summary: string; at: string; delivered: number;
    }[];
  }
}

export interface AlertRule {
  id: string;
  kind: string;
  threshold: number;
  enabled: number | boolean;
  webhook: string | null;
  student_id: string | null;
}

function arrivalSummary(assignment: ParsedAssignment): string {
  if (assignment.status === 'missing') return `Missing: ${assignment.title}`;
  if (assignment.status === 'late') return `Late: ${assignment.title}`;
  if (assignment.status === 'excused') return `Excused: ${assignment.title}`;
  if (assignment.due) return `New: ${assignment.title} due ${weekdayShort(assignment.due)}`;
  return `New: ${assignment.title}`;
}

function updateSummary(assignment: ParsedAssignment & { previousStatus?: string }): string | null {
  const previous = assignment.previousStatus;
  if (!previous || previous === assignment.status) {
    if (assignment.dropped) return `${assignment.title} was dropped`;
    return null;
  }
  if (assignment.status === 'missing') return `${assignment.title} is missing`;
  if (assignment.status === 'late') return `${assignment.title} is late`;
  if (assignment.status === 'excused') return `${assignment.title} was excused`;
  if (assignment.dropped) return `${assignment.title} was dropped`;
  return `${assignment.title} is now ${assignment.status.replace('_', ' ')}`;
}

function relativeLabel(thenIso: string, now: Date): string {
  const then = new Date(thenIso).getTime();
  const mins = Math.round((now.getTime() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shift(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function openStore(file: string): Store {
  return new Store(file);
}
