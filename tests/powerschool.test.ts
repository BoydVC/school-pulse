import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { fixedNow, fixture } from "./helpers.js";

const now = fixedNow();

test("PowerSchool quick-lookup HTML keeps the course and quarter grade", () => {
  const snapshot = parseSnapshot({ source: "powerschool", filename: "quick-lookup.html", raw: fixture("powerschool/quick-lookup.html"), now });
  assert.equal(snapshot.students[0]?.name, "Student A");
  assert.equal(snapshot.students[0]?.school, "Pinecrest Middle");
  assert.deepEqual(
    snapshot.courses.map((course) => course.name),
    ["Math", "Science"],
  );
  const math = snapshot.grades.find((grade) => grade.courseSourceId === "0041001");
  assert.equal(math?.percent, 91);
  assert.equal(math?.letter, "A-");
  const science = snapshot.grades.find((grade) => grade.courseSourceId === "0041002");
  assert.equal(science?.percent, 86);
  assert.equal(science?.letter, "B");
});

test("PowerSchool scores HTML reads missing, late, and graded rows", () => {
  const snapshot = parseSnapshot({ source: "powerschool", filename: "scores.html", raw: fixture("powerschool/scores.html"), now });
  assert.equal(snapshot.courses[0]?.name, "Science");
  assert.equal(snapshot.courses[0]?.sourceId, "0041002");
  assert.equal(snapshot.grades[0]?.percent, 86);
  const byId = new Map(snapshot.assignments.map((item) => [item.sourceId, item]));
  assert.equal(byId.get("9001")?.status, "missing");
  assert.equal(byId.get("9001")?.pointsPossible, 25);
  assert.equal(byId.get("9001")?.pointsEarned, null);
  assert.equal(byId.get("9002")?.status, "graded");
  assert.equal(byId.get("9002")?.pointsEarned, 15);
  assert.equal(byId.get("9003")?.status, "late");
  assert.equal(byId.get("9003")?.category, "Homework");
});

test("PowerSchool JSON portal export maps sections, scores, and flags", () => {
  const snapshot = parseSnapshot({ source: "powerschool", filename: "portal.json", raw: fixture("powerschool/portal.json"), now });
  assert.equal(snapshot.source, "powerschool");
  assert.equal(snapshot.students[0]?.name, "Student A");
  assert.equal(snapshot.students[0]?.sourceId, "stu-a");
  assert.equal(snapshot.grades[0]?.percent, 91);
  assert.equal(snapshot.grades[0]?.letter, "A-");
  const problem = snapshot.assignments.find((item) => item.sourceId === "ASG1001");
  const quiz = snapshot.assignments.find((item) => item.sourceId === "ASG1002");
  assert.equal(problem?.status, "assigned");
  assert.equal(problem?.pointsPossible, 20);
  assert.equal(quiz?.status, "graded");
  assert.equal(quiz?.pointsEarned, 18);
  assert.equal(snapshot.courses[0]?.period, "1(A)");
});
