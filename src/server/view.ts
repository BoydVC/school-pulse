import {
  SOURCE_LABEL,
  SOURCES,
  ageLabel,
  describeChange,
  inRange,
  isStale,
  utcDay,
  utcWeek,
  type IsoInstant,
  type Source,
} from "../domain/index.ts";
import { Store } from "../store/store.ts";
import { numberOrNull, text, textOrNull, type SqlRow } from "../store/rows.ts";

export type StudentPanel = {
  readonly id: string;
  readonly displayName: string;
  readonly schoolName: string | null;
  readonly dueToday: number;
  readonly dueThisWeek: number;
  readonly missing: number;
  readonly late: number;
};

export type AssignmentPanel = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly courseId: string;
  readonly courseName: string;
  readonly title: string;
  readonly status: string;
  readonly earned: number | null;
  readonly possible: number | null;
  readonly dueAt: string | null;
  readonly category: string | null;
  readonly source: string;
  readonly url: string | null;
};

export type CoursePanel = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly name: string;
  readonly teacher: string | null;
  readonly period: string | null;
  readonly percent: number | null;
  readonly letter: string | null;
  readonly delta: number | null;
  readonly trend: readonly number[];
  readonly source: string | null;
};

export type ChangePanel = {
  readonly id: string;
  readonly at: string;
  readonly text: string;
  readonly studentId: string;
  readonly kind: string;
  readonly source: string;
};

export type SourcePanel = {
  readonly source: string;
  readonly label: string;
  readonly fetchedAt: string | null;
  readonly stale: boolean;
  readonly ageLabel: string;
};

export type DashboardPayload = {
  readonly generatedAt: string;
  readonly students: readonly StudentPanel[];
  readonly assignments: readonly AssignmentPanel[];
  readonly courses: readonly CoursePanel[];
  readonly changes: readonly ChangePanel[];
  readonly sources: readonly SourcePanel[];
  readonly alertsEnabled: boolean;
};

const OPEN = new Set(["assigned", "turned_in", "missing", "late"]);

export function dashboard(store: Store, now: IsoInstant): DashboardPayload {
  const students = store.db.prepare("SELECT id, display_name, school_name FROM students ORDER BY display_name, id").all();
  const assignments = store.db
    .prepare(
      `SELECT a.id, a.student_id, s.display_name AS student_name, a.course_id, c.name AS course_name,
              a.title, a.status, a.earned, a.possible, a.due_at, a.category, a.source, a.url
       FROM assignments a
       JOIN students s ON s.id = a.student_id
       JOIN courses c ON c.id = a.course_id
       ORDER BY a.due_at IS NULL, a.due_at, a.title`,
    )
    .all()
    .map(assignmentPanel);
  const week = utcWeek(now);
  const today = utcDay(now);
  const studentPanels: StudentPanel[] = students.map((row) => {
    const id = text(row, "id");
    const mine = assignments.filter((item) => item.studentId === id);
    return {
      id,
      displayName: text(row, "display_name"),
      schoolName: textOrNull(row, "school_name"),
      dueToday: mine.filter((item) => item.dueAt !== null && utcDay(item.dueAt as IsoInstant) === today && OPEN.has(item.status)).length,
      dueThisWeek: mine.filter((item) => item.status !== "excused" && item.status !== "graded" && inRange(item.dueAt as IsoInstant | null, week)).length,
      missing: mine.filter((item) => item.status === "missing").length,
      late: mine.filter((item) => item.status === "late").length,
    };
  });
  const gradeRows = store.db
    .prepare(
      `SELECT g.course_id, g.percent, g.letter, g.as_of, g.source, c.student_id, c.name, c.teacher, c.period, s.display_name AS student_name
       FROM grade_snapshots g
       JOIN courses c ON c.id = g.course_id
       JOIN students s ON s.id = c.student_id
       ORDER BY g.as_of, g.id`,
    )
    .all();
  const courseRows = store.db
    .prepare(
      `SELECT c.id, c.student_id, c.name, c.teacher, c.period, s.display_name AS student_name
       FROM courses c JOIN students s ON s.id = c.student_id
       ORDER BY s.display_name, c.name`,
    )
    .all();
  const gradesByCourse = new Map<string, SqlRow[]>();
  for (const row of gradeRows) {
    const id = text(row, "course_id");
    const list = gradesByCourse.get(id);
    if (list) list.push(row);
    else gradesByCourse.set(id, [row]);
  }
  const courses: CoursePanel[] = courseRows.map((row) => {
    const id = text(row, "id");
    const history = gradesByCourse.get(id) ?? [];
    const trend = history.flatMap((grade) => {
      const percent = numberOrNull(grade, "percent");
      return percent === null ? [] : [percent];
    });
    const latest = history.length > 0 ? history[history.length - 1] : undefined;
    const previous = trend.length >= 2 ? trend[trend.length - 2] : undefined;
    const current = trend.length > 0 ? trend[trend.length - 1] : undefined;
    return {
      id,
      studentId: text(row, "student_id"),
      studentName: text(row, "student_name"),
      name: text(row, "name"),
      teacher: textOrNull(row, "teacher"),
      period: textOrNull(row, "period"),
      percent: current ?? null,
      letter: latest ? textOrNull(latest, "letter") : null,
      delta: current !== undefined && previous !== undefined ? Math.round((current - previous) * 10) / 10 : null,
      trend,
      source: latest ? text(latest, "source") : null,
    };
  });
  const changes: ChangePanel[] = store.changes().map((change) => ({
    id: change.id,
    at: change.at,
    text: describeChange(change),
    studentId: change.studentId,
    kind: change.kind,
    source: change.source,
  }));
  const fetches = new Map<string, string>();
  for (const row of store.db.prepare("SELECT source, fetched_at FROM source_fetches").all()) {
    fetches.set(text(row, "source"), text(row, "fetched_at"));
  }
  const sources: SourcePanel[] = SOURCES.filter((source) => fetches.has(source)).map((source) => {
    const fetchedAt = fetches.get(source) ?? null;
    return {
      source,
      label: SOURCE_LABEL[source],
      fetchedAt,
      stale: isStale(fetchedAt as IsoInstant | null, now),
      ageLabel: fetchedAt ? ageLabel(fetchedAt as IsoInstant, now) : "never",
    };
  });
  return {
    generatedAt: now,
    students: studentPanels,
    assignments,
    courses,
    changes,
    sources,
    alertsEnabled: store.rules().some((rule) => rule.enabled),
  };
}

function assignmentPanel(row: SqlRow): AssignmentPanel {
  return {
    id: text(row, "id"),
    studentId: text(row, "student_id"),
    studentName: text(row, "student_name"),
    courseId: text(row, "course_id"),
    courseName: text(row, "course_name"),
    title: text(row, "title"),
    status: text(row, "status"),
    earned: numberOrNull(row, "earned"),
    possible: numberOrNull(row, "possible"),
    dueAt: textOrNull(row, "due_at"),
    category: textOrNull(row, "category"),
    source: text(row, "source"),
    url: textOrNull(row, "url"),
  };
}

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
