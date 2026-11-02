import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { assignmentDraft } from "../src/domain/index.js";
import { enforceSnapshot } from "../src/domain/enforce.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { openDatabase } from "../src/store/db.js";

test("graded work without points and an empty grade cannot be constructed", () => {
  const graded = assignmentDraft({
    source: "generic",
    sourceId: "a",
    householdKey: "student-a",
    courseName: "Math",
    title: "Quiz",
    status: "graded",
    earned: null,
    possible: null,
    assignedAt: null,
    dueAt: null,
    category: null,
    url: null,
  });
  assert.equal(graded.ok, false);
  const missing = assignmentDraft({
    source: "generic",
    sourceId: "b",
    householdKey: "student-a",
    courseName: "Math",
    title: "Quiz",
    status: "missing",
    earned: 5,
    possible: 10,
    assignedAt: null,
    dueAt: null,
    category: null,
    url: null,
  });
  assert.equal(missing.ok, false);
});

test("sqlite repeats the point and grade invariants", () => {
  const db = openDatabase(":memory:");
  const student = db.prepare(
    "INSERT INTO students (id, source, source_id, name, fetched_at) VALUES ('s', 'generic', 's', 'Student A', '2026-11-02T00:00:00.000Z')",
  );
  student.run();
  db.prepare(
    "INSERT INTO courses (id, student_id, source, source_id, name, fetched_at) VALUES ('c', 's', 'generic', 'c', 'Math', '2026-11-02T00:00:00.000Z')",
  ).run();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO assignments (id, student_id, course_id, title, status, points_earned, points_possible, source, source_id, last_seen, fetched_at)
       VALUES ('a', 's', 'c', 'Quiz', 'graded', NULL, NULL, 'generic', 'a', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`,
    ).run();
  });
  assert.throws(() => {
    db.prepare(
      `INSERT INTO grade_snapshots (id, student_id, course_id, percent, letter, as_of, source, fetched_at)
       VALUES ('g', 's', 'c', NULL, NULL, '2026-11-02T00:00:00.000Z', 'generic', '2026-11-02T00:00:00.000Z')`,
    ).run();
  });
});

test("ingest coerces a missing row to zero earned and keeps the re-ingest quiet", () => {
  const db = openDatabase(":memory:");
  const raw = {
    source: "generic",
    fetchedAt: "2026-11-02T22:30:00.000Z",
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: [{ sourceId: "lab", studentSourceId: "stu-a", courseSourceId: "math", title: "Lab report", status: "missing", pointsPossible: 25 }],
    grades: [{ studentSourceId: "stu-a", courseSourceId: "math", percent: 91, letter: "A-", asOf: "2026-11-02T22:30:00.000Z" }],
  };
  const snapshot = enforceSnapshot({
    source: "generic",
    fetchedAt: raw.fetchedAt,
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle", gradeLevel: null }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math", teacher: null, period: null }],
    assignments: [{ sourceId: "lab", studentSourceId: "stu-a", courseSourceId: "math", title: "Lab report", due: null, assigned: null, status: "missing", pointsEarned: null, pointsPossible: 25, category: null, url: null, groupKey: null }],
    grades: [{ studentSourceId: "stu-a", courseSourceId: "math", percent: 91, letter: "A-", asOf: "2026-11-02T22:30:00.000Z" }],
    replaceGroups: [],
    notes: [],
  });
  assert.equal(snapshot.assignments[0]?.pointsEarned, 0);
  const now = new Date("2026-11-02T22:30:00.000Z");
  const parsed = parseSnapshot({ source: "generic", filename: "a.json", raw: JSON.stringify(raw), now });
  const first = ingestSnapshot(db, parsed, now);
  const second = ingestSnapshot(db, parsed, now);
  assert.equal(first.assignmentsInserted, 1);
  assert.equal(second.unchanged, true);
});
