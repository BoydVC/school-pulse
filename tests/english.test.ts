import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeDueChange,
  describeGradeChange,
  describeNewAssignment,
  describeStatusChange,
} from "../src/model/english.js";

test("grade changes are plain speech", () => {
  assert.equal(describeGradeChange("Math", 91, "A-", 84, "B"), "Math went from 91 to 84");
  assert.equal(describeGradeChange("Math", 84, "B", 76, "C"), "Math went from 84 to 76");
  assert.equal(describeGradeChange("Art", null, "A-", null, "B"), "Art went from A- to B");
});

test("new work names the day", () => {
  assert.equal(describeNewAssignment("Science lab", "Fri"), "New: Science lab due Fri");
  assert.equal(describeNewAssignment("Field trip form", "tonight"), "New: Field trip form due tonight");
  assert.equal(describeNewAssignment("Poster", null), "New: Poster");
});

test("status changes say what happened", () => {
  assert.equal(describeStatusChange("Essay draft", "turned_in", null, 40), "Essay draft turned in");
  assert.equal(describeStatusChange("Lab report", "missing", null, 25), "Lab report marked missing");
  assert.equal(describeStatusChange("Reading guide", "late", null, 10), "Reading guide is late");
  assert.equal(describeStatusChange("Quiz 4", "graded", 18, 20), "Quiz 4 scored 18/20");
  assert.equal(describeDueChange("Map skills", "Fri"), "Map skills moved to Fri");
});
