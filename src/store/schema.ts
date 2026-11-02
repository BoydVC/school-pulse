import { ASSIGNMENT_STATUSES, SOURCES } from "../domain/index.ts";

/**
 * SQLite schema is generated from this module so the column list, the source
 * enum, and the assignment status enum stay aligned with the domain types.
 * CHECK constraints repeat the invariants the constructors already enforce:
 * graded rows have earned <= possible, missing rows have earned 0, and a
 * grade snapshot cannot be empty.
 */
export const SCHEMA_VERSION = 1 as const;

export const TABLE_NAMES = [
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

export type TableName = (typeof TABLE_NAMES)[number];

const sourceCheck = `CHECK (source IN (${SOURCES.map((source) => `'${source}'`).join(", ")}))`;
const statusCheck = `CHECK (status IN (${ASSIGNMENT_STATUSES.map((status) => `'${status}'`).join(", ")}))`;
const letterCheck = `CHECK (letter IS NULL OR letter IN ('A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'))`;

const tables: Record<TableName, readonly string[]> = {
  meta: ["key TEXT PRIMARY KEY", "value TEXT NOT NULL"],
  students: [
    "id TEXT PRIMARY KEY",
    "household_key TEXT NOT NULL UNIQUE",
    "display_name TEXT NOT NULL",
    "school_name TEXT",
    "created_at TEXT NOT NULL",
    "updated_at TEXT NOT NULL",
  ],
  student_sources: [
    "student_id TEXT NOT NULL REFERENCES students(id)",
    "source TEXT NOT NULL",
    "source_id TEXT NOT NULL",
    "fetched_at TEXT NOT NULL",
    `PRIMARY KEY (source, source_id)`,
    sourceCheck,
  ],
  courses: [
    "id TEXT PRIMARY KEY",
    "student_id TEXT NOT NULL REFERENCES students(id)",
    "name TEXT NOT NULL",
    "name_key TEXT NOT NULL",
    "teacher TEXT",
    "period TEXT",
    "created_at TEXT NOT NULL",
    "updated_at TEXT NOT NULL",
    "UNIQUE (student_id, name_key)",
  ],
  course_sources: [
    "course_id TEXT NOT NULL REFERENCES courses(id)",
    "source TEXT NOT NULL",
    "source_id TEXT NOT NULL",
    "fetched_at TEXT NOT NULL",
    "PRIMARY KEY (source, source_id)",
    sourceCheck,
  ],
  assignments: [
    "id TEXT PRIMARY KEY",
    "student_id TEXT NOT NULL REFERENCES students(id)",
    "course_id TEXT NOT NULL REFERENCES courses(id)",
    "source TEXT NOT NULL",
    "source_id TEXT NOT NULL",
    "title TEXT NOT NULL",
    "status TEXT NOT NULL",
    "earned REAL",
    "possible REAL",
    "category TEXT",
    "url TEXT",
    "assigned_at TEXT",
    "due_at TEXT",
    "fetched_at TEXT NOT NULL",
    "last_seen TEXT NOT NULL",
    "content_hash TEXT NOT NULL",
    "UNIQUE (source, source_id)",
    sourceCheck,
    statusCheck,
    "CHECK (possible IS NULL OR possible > 0)",
    "CHECK (earned IS NULL OR earned >= 0)",
    `CHECK (
      (status = 'graded' AND earned IS NOT NULL AND possible IS NOT NULL AND earned <= possible)
      OR (status = 'missing' AND earned = 0)
      OR (status = 'late' AND (earned IS NULL OR possible IS NULL OR earned <= possible))
      OR (status IN ('assigned', 'turned_in', 'excused') AND earned IS NULL)
    )`,
  ],
  grade_snapshots: [
    "id TEXT PRIMARY KEY",
    "student_id TEXT NOT NULL REFERENCES students(id)",
    "course_id TEXT NOT NULL REFERENCES courses(id)",
    "source TEXT NOT NULL",
    "source_id TEXT NOT NULL",
    "percent REAL",
    "letter TEXT",
    "as_of TEXT NOT NULL",
    "fetched_at TEXT NOT NULL",
    "UNIQUE (source, source_id, as_of)",
    sourceCheck,
    letterCheck,
    "CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100))",
    "CHECK (percent IS NOT NULL OR letter IS NOT NULL)",
  ],
  changes: [
    "id TEXT PRIMARY KEY",
    "kind TEXT NOT NULL CHECK (kind IN ('grade','assignment_new','assignment_status','assignment_score'))",
    "student_id TEXT NOT NULL",
    "course_id TEXT NOT NULL",
    "assignment_id TEXT",
    "source TEXT NOT NULL",
    "payload TEXT NOT NULL",
    "at TEXT NOT NULL",
    sourceCheck,
  ],
  ingest_receipts: [
    "content_hash TEXT PRIMARY KEY",
    "source TEXT NOT NULL",
    "filename TEXT NOT NULL",
    "ingested_at TEXT NOT NULL",
    sourceCheck,
  ],
  source_fetches: ["source TEXT PRIMARY KEY", "fetched_at TEXT NOT NULL", sourceCheck],
  alert_rules: [
    "kind TEXT PRIMARY KEY CHECK (kind IN ('grade_below','missing_above','grade_drop'))",
    "enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)) DEFAULT 0",
    "config TEXT NOT NULL",
  ],
  alert_events: [
    "id TEXT PRIMARY KEY",
    "kind TEXT NOT NULL",
    "student_id TEXT NOT NULL",
    "message TEXT NOT NULL",
    "at TEXT NOT NULL",
    "payload TEXT NOT NULL",
  ],
};

export function ddl(): string {
  const creates = TABLE_NAMES.map((name) => {
    const columns = tables[name].join(",\n  ");
    return `CREATE TABLE ${name} (\n  ${columns}\n);`;
  });
  const indexes = [
    "CREATE INDEX idx_assignments_student ON assignments(student_id, due_at);",
    "CREATE INDEX idx_assignments_status ON assignments(status);",
    "CREATE INDEX idx_grades_course ON grade_snapshots(course_id, as_of);",
    "CREATE INDEX idx_changes_at ON changes(at);",
  ];
  return [...creates, ...indexes].join("\n\n");
}

export type AssignmentRow = {
  readonly id: string;
  readonly student_id: string;
  readonly course_id: string;
  readonly source: string;
  readonly source_id: string;
  readonly title: string;
  readonly status: string;
  readonly earned: number | null;
  readonly possible: number | null;
  readonly category: string | null;
  readonly url: string | null;
  readonly assigned_at: string | null;
  readonly due_at: string | null;
  readonly fetched_at: string;
  readonly last_seen: string;
  readonly content_hash: string;
};

export type GradeRow = {
  readonly id: string;
  readonly student_id: string;
  readonly course_id: string;
  readonly source: string;
  readonly source_id: string;
  readonly percent: number | null;
  readonly letter: string | null;
  readonly as_of: string;
  readonly fetched_at: string;
};
