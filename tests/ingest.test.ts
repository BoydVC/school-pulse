import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { listAssignments, listChanges, listGrades, openDatabase } from "../src/store/db.js";
import { fixedNow, fixture } from "./helpers.js";

const now = fixedNow();

test("the same PowerSchool file changes nothing the second time", () => {
  const db = openDatabase(":memory:");
  const firstNow = now;
  const later = new Date(now.getTime() + 60 * 60_000);
  const first = parseSnapshot({ source: "powerschool", filename: "scores.html", raw: fixture("powerschool/scores.html"), now: firstNow });
  const second = parseSnapshot({ source: "powerschool", filename: "scores.html", raw: fixture("powerschool/scores.html"), now: later });
  const opened = ingestSnapshot(db, first, firstNow);
  assert.equal(opened.assignmentsInserted, 3);
  assert.equal(listGrades(db).length, 1);
  const again = ingestSnapshot(db, second, later);
  assert.equal(again.unchanged, true);
  assert.equal(again.changes.length, 0);
  assert.equal(listAssignments(db).length, 3);
  assert.equal(listGrades(db).length, 1);
  assert.equal(listChanges(db).length, opened.changes.length);
});

test("a grade history import does not narrate every old point", () => {
  const db = openDatabase(":memory:");
  const snapshot = parseSnapshot({
    source: "generic",
    filename: "history.json",
    raw: JSON.stringify({
      students: [{ sourceId: "stu-a", name: "Student A" }],
      courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
      grades: [
        { studentSourceId: "stu-a", courseSourceId: "math", percent: 96, letter: "A", asOf: "2026-10-05T16:00:00.000Z" },
        { studentSourceId: "stu-a", courseSourceId: "math", percent: 91, letter: "A-", asOf: "2026-10-26T16:00:00.000Z" },
      ],
    }),
    now,
  });
  const result = ingestSnapshot(db, snapshot, now);
  assert.equal(result.changes.length, 0);
  assert.equal(listGrades(db).length, 2);
});

test("a later snapshot says the grade went from 91 to 84", () => {
  const db = openDatabase(":memory:");
  const base = household(91, "2026-11-01T16:00:00.000Z");
  const next = household(84, "2026-11-02T17:00:00.000Z");
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a.json", raw: JSON.stringify(base), now }), now);
  const result = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "b.json", raw: JSON.stringify(next), now }), now);
  assert.deepEqual(result.changes.map((change) => change.summary), ["Math went from 91 to 84"]);
  const repeat = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "b.json", raw: JSON.stringify(next), now }), now);
  assert.equal(repeat.unchanged, true);
  assert.equal(listGrades(db).length, 2);
});

test("republishing the same percent later does not add a point", () => {
  const db = openDatabase(":memory:");
  const first = household(84, "2026-11-02T17:00:00.000Z");
  const again = household(84, "2026-11-02T18:00:00.000Z");
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a.json", raw: JSON.stringify(first), now }), now);
  const result = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "b.json", raw: JSON.stringify(again), now }), now);
  assert.equal(result.unchanged, true);
  assert.equal(listGrades(db).length, 1);
});

test("a new assignment after the baseline is announced", () => {
  const db = openDatabase(":memory:");
  const base = household(91, "2026-11-01T16:00:00.000Z");
  base.assignments = [
    { sourceId: "a1", studentSourceId: "stu-a", courseSourceId: "math", title: "Quiz 4", status: "graded", pointsEarned: 18, pointsPossible: 20 },
    { sourceId: "a2", studentSourceId: "stu-a", courseSourceId: "math", title: "Warm-up", status: "graded", pointsEarned: 10, pointsPossible: 10 },
    { sourceId: "a3", studentSourceId: "stu-a", courseSourceId: "math", title: "Packet", status: "graded", pointsEarned: 5, pointsPossible: 5 },
    { sourceId: "a4", studentSourceId: "stu-a", courseSourceId: "math", title: "Review", status: "assigned" },
  ];
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "base.json", raw: JSON.stringify(base), now }), now);
  assert.equal(listChanges(db).filter((change) => change.kind === "assignment_new").length, 0);
  const extra = household(91, "2026-11-01T16:00:00.000Z");
  extra.assignments = [{ sourceId: "a5", studentSourceId: "stu-a", courseSourceId: "math", title: "Science lab", status: "assigned", due: "2026-11-06T23:59:00.000Z" }];
  const result = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "extra.json", raw: JSON.stringify(extra), now }), now);
  assert.equal(result.changes[0]?.summary, "New: Science lab due Fri");
});

test("status edits become a sentence and then stay quiet", () => {
  const db = openDatabase(":memory:");
  const base = household(90, "2026-11-01T16:00:00.000Z");
  base.assignments = [{ sourceId: "lab", studentSourceId: "stu-a", courseSourceId: "math", title: "Lab report", status: "assigned", pointsPossible: 25 }];
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "base.json", raw: JSON.stringify(base), now }), now);
  const updated = household(90, "2026-11-01T16:00:00.000Z");
  updated.assignments = [{ sourceId: "lab", studentSourceId: "stu-a", courseSourceId: "math", title: "Lab report", status: "missing", pointsPossible: 25 }];
  const result = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "edit.json", raw: JSON.stringify(updated), now }), now);
  assert.equal(result.changes[0]?.summary, "Lab report marked missing");
  const repeat = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "edit.json", raw: JSON.stringify(updated), now }), now);
  assert.equal(repeat.unchanged, true);
});

function household(percent: number, asOf: string): {
  students: unknown[];
  courses: unknown[];
  assignments: unknown[];
  grades: unknown[];
} {
  return {
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math", teacher: "Teacher A" }],
    assignments: [],
    grades: [{ studentSourceId: "stu-a", courseSourceId: "math", percent, letter: "B", asOf }],
  };
}
