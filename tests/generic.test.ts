import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { fixedNow, fixture } from "./helpers.js";

const now = fixedNow();

test("generic JSON matches the core schema", () => {
  const snapshot = parseSnapshot({ source: "generic", filename: "snapshot.json", raw: fixture("generic/snapshot.json"), now });
  assert.equal(snapshot.assignments.length, 2);
  assert.equal(snapshot.grades.length, 2);
  assert.equal(snapshot.assignments[0]?.title, "Problem set 12");
  assert.equal(snapshot.grades[1]?.percent, 84);
});

test("generic CSV accepts quotes and blank scores", () => {
  const snapshot = parseSnapshot({ source: "generic", filename: "assignments.csv", raw: fixture("generic/assignments.csv"), now });
  assert.equal(snapshot.students[0]?.name, "Student B");
  assert.equal(snapshot.courses.length, 1);
  assert.equal(snapshot.assignments[1]?.title, "Book talk, draft");
  assert.equal(snapshot.assignments[0]?.status, "missing");
  assert.equal(snapshot.assignments[0]?.pointsEarned, null);
  assert.equal(snapshot.grades[0]?.percent, 78);
  assert.equal(snapshot.grades.length, 1);
});

test("generic JSON skips an unknown status and keeps the other rows", () => {
  const raw = JSON.stringify({
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "c", studentSourceId: "stu-a", name: "Math" }],
    assignments: [
      { sourceId: "a", studentSourceId: "stu-a", courseSourceId: "c", title: "HW", status: "assigned" },
      { sourceId: "b", studentSourceId: "stu-a", courseSourceId: "c", title: "HW", status: "lost" },
    ],
  });
  const snapshot = parseSnapshot({ source: "generic", filename: "bad.json", raw, now });
  assert.equal(snapshot.assignments.length, 1);
  assert.equal(snapshot.assignments[0]?.sourceId, "a");
  assert.deepEqual(snapshot.rejected, [{ index: 1, reason: 'Unknown assignment status "lost" on HW' }]);
});

test("sniffs a Classroom export dropped without a source flag", () => {
  const snapshot = parseSnapshot({ filename: "drop.json", raw: fixture("google-classroom/export.json"), now });
  assert.equal(snapshot.source, "google-classroom");
});
