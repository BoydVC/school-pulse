import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { fixedNow, fixture } from "./helpers.js";

test("Classroom courseWork and submissions map onto the household model", () => {
  const now = fixedNow();
  const snapshot = parseSnapshot({
    source: "google-classroom",
    filename: "export.json",
    raw: fixture("google-classroom/export.json"),
    now,
  });
  assert.equal(snapshot.students[0]?.name, "Student A");
  assert.equal(snapshot.courses.length, 1);
  assert.equal(snapshot.courses[0]?.name, "English");
  assert.equal(snapshot.courses[0]?.teacher, "Teacher C");
  const byTitle = new Map(snapshot.assignments.map((item) => [item.title, item]));
  assert.equal(byTitle.size, 4);
  assert.equal(byTitle.get("Reading log")?.status, "assigned");
  assert.equal(byTitle.get("Response journal")?.status, "missing");
  assert.equal(byTitle.get("Essay draft")?.status, "late");
  assert.equal(byTitle.get("Vocabulary quiz")?.status, "graded");
  assert.equal(byTitle.get("Vocabulary quiz")?.pointsEarned, 18);
  assert.equal(byTitle.get("Vocabulary quiz")?.pointsPossible, 20);
  assert.equal(byTitle.has("Syllabus"), false);
  assert.equal(snapshot.assignments[0]?.url?.includes("classroom.example.test"), true);
});
