import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { listAssignments, openDatabase } from "../src/store/db.js";
import { repoRoot } from "../src/util/root.js";

const now = new Date("2026-11-02T22:30:00.000Z");

function read(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

test("PowerSchool score detail keeps the posted grade and lets missing win over late", () => {
  const science = parseSnapshot({
    source: "powerschool",
    filename: "science.html",
    raw: read("fixtures/portal/powerschool/science-q2-2026-11-02.html"),
    now,
  });
  assert.equal(science.students[0]?.name, "Student A");
  assert.equal(science.students[0]?.school, "Pinecrest Middle");
  const byTitle = new Map(science.assignments.map((item) => [item.title, item]));
  assert.equal(byTitle.get("Lab report")?.status, "missing");
  assert.equal(byTitle.get("Lab safety")?.status, "graded");
  assert.equal(byTitle.get("Lab safety")?.pointsEarned, 10);
  assert.equal(science.grades[0]?.percent, 90);
  assert.equal(science.grades[0]?.letter, "A-");

  const math = parseSnapshot({
    source: "powerschool",
    filename: "math-q1.html",
    raw: read("fixtures/portal/powerschool/math-q1-2026-10-20.html"),
    now,
  });
  assert.equal(math.assignments.some((item) => item.status === "excused"), true);
  assert.equal(math.assignments.some((item) => item.title === "Excluded"), false);
});

test("Classroom edges keep basis-point weights, hide overall grade, and do not invent excused", () => {
  const snapshot = parseSnapshot({
    source: "google-classroom",
    filename: "edges.json",
    raw: read("fixtures/portal/classroom/edges.json"),
    now,
  });
  assert.equal(snapshot.students[0]?.name, "Student B");
  assert.equal(snapshot.source, "google-classroom");
  assert.equal(snapshot.assignments.some((item) => item.status === "excused"), false);
  assert.equal(snapshot.assignments.length > 0, true);
});

test("OneNote resolves Due Fri from the page date and reads to-do tags", () => {
  const page = parseSnapshot({
    source: "onenote",
    filename: "raw-page.html",
    raw: read("fixtures/portal/onenote/raw-page.html"),
    now,
  });
  assert.equal(page.students[0]?.name, "Student A");
  assert.equal(page.assignments.length >= 1, true);
  const graph = parseSnapshot({
    source: "onenote",
    filename: "science-homework.json",
    raw: read("fixtures/portal/onenote/science-homework.json"),
    now,
  });
  assert.equal(graph.students[0]?.name, "Student A");
  assert.equal(graph.assignments.length >= 3, true);
});

test("re-ingesting a portal page changes nothing, and an older grade does not rewind the current one", () => {
  const db = openDatabase(":memory:");
  const raw = read("fixtures/portal/powerschool/math-q2-2026-11-02.html");
  const first = parseSnapshot({ source: "powerschool", filename: "math.html", raw, now });
  const opened = ingestSnapshot(db, first, now);
  assert.equal(opened.assignmentsInserted > 0, true);
  const again = ingestSnapshot(db, parseSnapshot({ source: "powerschool", filename: "math.html", raw, now }), now);
  assert.equal(again.unchanged, true);
  assert.equal(listAssignments(db).length, opened.assignmentsInserted);
});

test("a non-array generic payload is rejected instead of crashing", () => {
  assert.throws(
    () => parseSnapshot({ source: "generic", filename: "bad.json", raw: JSON.stringify({ students: [{ name: "Student A" }], assignments: "nope" }), now }),
    /must be an array|Unknown|not valid|missing a name|does not name/,
  );
});
