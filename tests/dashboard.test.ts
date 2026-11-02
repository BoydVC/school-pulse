import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { seedDemo } from "../src/demo/seed.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { listAssignments, listChanges, listGrades, openDatabase } from "../src/store/db.js";
import { repoRoot } from "../src/util/root.js";
import { fixedNow } from "./helpers.js";

test("demo household is two students, three sources, and at least twelve assignments", () => {
  const now = fixedNow();
  const db = openDatabase(":memory:");
  seedDemo(db, now);
  const board = buildDashboard(db, now);
  assert.deepEqual(
    board.students.map((student) => student.name),
    ["Student A", "Student B"],
  );
  assert.equal(board.counts.assignments >= 12, true);
  assert.equal(board.counts.assignments, 17);
  assert.deepEqual(
    board.sources.map((source) => source.source),
    ["powerschool", "google-classroom", "onenote"],
  );
  assert.equal(board.sources.find((source) => source.source === "onenote")?.state, "stale");
  assert.equal(board.sources.find((source) => source.source === "powerschool")?.state, "fresh");
  assert.equal(board.tonight.headline.join(" · "), "2 missing · 1 late · 3 due tonight");
  assert.match(board.tonight.detail, /Oldest is Lab report/);
  const summaries = board.changes.map((change) => change.summary);
  assert.deepEqual(
    summaries.filter((summary) => summary !== "baseline loaded"),
    ["Math went from 91 to 84", "Lab report marked missing", "Essay draft turned in"],
  );
  assert.equal(summaries.filter((summary) => summary === "baseline loaded").length, 3);
  const math = board.grades.find((grade) => grade.studentName === "Student A" && grade.courseName === "Math");
  const english = board.grades.find((grade) => grade.studentName === "Student A" && grade.courseName === "English");
  assert.equal(math?.percentLabel, "84");
  assert.equal(math?.delta, -7);
  assert.deepEqual(math?.spark, [96, 95, 94, 93, 91, 84]);
  assert.equal(english?.delta, null);
  assert.deepEqual(english?.spark, [88, 87, 88, 88, 88]);
  assert.equal(board.missing.length, 3);
});

test("seeding the demo twice changes nothing", () => {
  const now = fixedNow();
  const db = openDatabase(":memory:");
  seedDemo(db, now);
  const changes = listChanges(db).length;
  const assignments = listAssignments(db).length;
  const grades = listGrades(db).length;
  seedDemo(db, now);
  assert.equal(listChanges(db).length, changes);
  assert.equal(listAssignments(db).length, assignments);
  assert.equal(listGrades(db).length, grades);
});

test("the live-update fixture moves Math and adds tonight's missing form", () => {
  const now = fixedNow();
  const db = openDatabase(":memory:");
  seedDemo(db, now);
  const raw = readFileSync(join(repoRoot(), "fixtures/demo/live-update.json"), "utf8");
  const snapshot = parseSnapshot({ source: "powerschool", filename: "fixtures/demo/live-update.json", raw, now });
  const result = ingestSnapshot(db, snapshot, now);
  assert.deepEqual(
    result.changes.map((change) => change.summary).sort(),
    ["Math went from 84 to 76", "New: Field trip form due tonight"].sort(),
  );
  const board = buildDashboard(db, now);
  assert.equal(board.tonight.headline.join(" · "), "3 missing · 1 late · 3 due tonight");
  assert.equal(board.grades.find((grade) => grade.studentName === "Student A" && grade.courseName === "Math")?.percentLabel, "76");
  const repeat = ingestSnapshot(db, snapshot, now);
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.changes.length, 0);
});
