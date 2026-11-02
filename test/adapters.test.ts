import assert from "node:assert/strict";
import test from "node:test";
import { classroomAdapter } from "../src/adapters/classroom.ts";
import { genericAdapter } from "../src/adapters/generic.ts";
import { onenoteAdapter } from "../src/adapters/onenote.ts";
import { powerschoolAdapter } from "../src/adapters/powerschool.ts";
import { fixture, fixedNow } from "./helpers.ts";

const now = fixedNow();

test("powerschool HTML keeps grades, missing, late, and excused work", () => {
  const parsed = powerschoolAdapter.parse({ format: "html", filename: "portal.html", text: fixture("powerschool/portal.html"), now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.students[0]?.displayName, "Student A");
  assert.equal(parsed.value.students[0]?.schoolName, "Pinecrest Middle");
  assert.equal(parsed.value.grades.find((grade) => grade.courseName === "Math 7")?.value.percent, 91);
  const byTitle = new Map<string, string>(parsed.value.assignments.map((row) => [row.title, row.status]));
  assert.equal(byTitle.get("Integer patterns"), "graded");
  assert.equal(byTitle.get("Reading log"), "late");
  assert.equal(byTitle.get("Cell lab"), "missing");
  assert.equal(byTitle.get("Essay outline"), "turned_in");
  assert.equal(byTitle.get("Map skills"), "excused");
  const integers = parsed.value.assignments.find((row) => row.title === "Integer patterns");
  assert.equal(integers?.status === "graded" && integers.points.earned, 18);
});

test("powerschool JSON rejects an impossible graded row", () => {
  const text = fixture("powerschool/grades.json").replace('"possible": 10', '"possible": 4, "earned": 9');
  const broken = text.replace('"status": "assigned"', '"status": "graded"');
  const parsed = powerschoolAdapter.parse({ format: "json", filename: "grades.json", text: broken, now });
  assert.equal(parsed.ok, false);
});

test("powerschool JSON reads history and a date-only due date", () => {
  const parsed = powerschoolAdapter.parse({ format: "json", filename: "grades.json", text: fixture("powerschool/grades.json"), now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.grades.length, 2);
  assert.equal(parsed.value.assignments[0]?.dueAt, "2026-11-03T23:59:00.000Z");
});

test("onenote HTML parses prose dates and a structured row", () => {
  const parsed = onenoteAdapter.parse({ format: "html", filename: "page.html", text: fixture("onenote/page.html"), now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const titles = parsed.value.assignments.map((row) => row.title).sort();
  assert.deepEqual(titles, ["Listening log", "Verb drill", "Vocabulary set 4"]);
  const vocab = parsed.value.assignments.find((row) => row.title === "Vocabulary set 4");
  const listening = parsed.value.assignments.find((row) => row.title === "Listening log");
  const drill = parsed.value.assignments.find((row) => row.title === "Verb drill");
  assert.equal(vocab?.dueAt, "2026-11-06T23:59:00.000Z");
  assert.equal(listening?.status, "turned_in");
  assert.equal(listening?.dueAt, "2026-11-04T23:59:00.000Z");
  assert.equal(drill?.dueAt, "2026-11-06T23:59:00.000Z");
  assert.equal(parsed.value.courses[0]?.name, "Spanish 8");
});

test("onenote Graph JSON resolves Friday from the snapshot clock", () => {
  const parsed = onenoteAdapter.parse({ format: "json", filename: "pages.json", text: fixture("onenote/pages.json"), now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.assignments[0]?.title, "Vocabulary set 4");
  assert.equal(parsed.value.assignments[0]?.dueAt, "2026-11-06T23:59:00.000Z");
  assert.equal(parsed.value.students[0]?.displayName, "Student B");
});

test("classroom export maps returned, upcoming, and past-due work", () => {
  const parsed = classroomAdapter.parse({
    format: "json",
    filename: "export.json",
    text: fixture("google-classroom/export.json"),
    now,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const byTitle = new Map<string, (typeof parsed.value.assignments)[number]>(parsed.value.assignments.map((row) => [row.title, row]));
  assert.equal(byTitle.get("Problem set 4")?.status, "assigned");
  assert.equal(byTitle.get("Civilizations quiz")?.status, "graded");
  assert.equal(byTitle.get("Document packet")?.status, "missing");
  const quiz = byTitle.get("Civilizations quiz");
  assert.equal(quiz?.status === "graded" && quiz.points.earned, 42);
  assert.equal(parsed.value.grades[0]?.value.percent, 92);
  assert.equal(byTitle.get("Problem set 4")?.dueAt, "2026-11-05T23:59:00.000Z");
});

test("classroom can derive a course percent from graded submissions", () => {
  const body = JSON.parse(fixture("google-classroom/export.json")) as { courseGrades?: unknown; deriveCourseGrades?: boolean };
  delete body.courseGrades;
  body.deriveCourseGrades = true;
  const parsed = classroomAdapter.parse({ format: "json", filename: "export.json", text: JSON.stringify(body), now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const history = parsed.value.grades.find((grade) => grade.courseName === "World History 8");
  assert.equal(history?.value.percent, 84);
});

test("generic JSON and CSV describe the same practice set", () => {
  const json = genericAdapter.parse({ format: "json", filename: "snapshot.json", text: fixture("generic/snapshot.json"), now });
  const csv = genericAdapter.parse({ format: "csv", filename: "assignments.csv", text: fixture("generic/assignments.csv"), now });
  assert.equal(json.ok && csv.ok, true);
  if (!json.ok || !csv.ok) return;
  assert.equal(json.value.assignments[0]?.title, "Practice set");
  assert.equal(csv.value.assignments[0]?.title, "Practice set");
  assert.equal(json.value.grades[0]?.value.percent, 91);
  assert.equal(csv.value.grades[0]?.value.letter, "A-");
  assert.equal(json.value.assignments[0]?.url, "https://example.invalid/practice");
});

test("generic JSON rejects a percent above 100", () => {
  const text = fixture("generic/snapshot.json").replace('"percent": 91', '"percent": 140');
  const parsed = genericAdapter.parse({ format: "json", filename: "snapshot.json", text, now });
  assert.equal(parsed.ok, false);
});
