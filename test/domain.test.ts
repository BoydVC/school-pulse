import assert from "node:assert/strict";
import test from "node:test";
import {
  addUtcDays,
  ageLabel,
  assignmentDraft,
  courseName,
  describeChange,
  explain,
  gradeValue,
  gradedPoints,
  householdKey,
  httpUrl,
  instant,
  letterGrade,
  parseDue,
  percent,
  personName,
  utcWeek,
  weekdayShort,
} from "../src/domain/index.ts";

const NOW = instant("2026-11-02T18:00:00.000Z");
if (!NOW.ok) throw new Error("fixture clock");

test("percent rejects values outside 0..100", () => {
  assert.equal(percent(0).ok, true);
  assert.equal(percent(100).ok, true);
  assert.equal(percent(91.5).ok, true);
  for (const value of [-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = percent(value);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error.kind, "bad_percent");
  }
});

test("letter grades are a closed scale", () => {
  const parsed = letterGrade("a-");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value, "A-");
  const rejected = letterGrade("Z");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(explain(rejected.error), /A\+/);
});

test("empty grades and over-earned points cannot be built", () => {
  assert.equal(gradeValue(null, null).ok, false);
  assert.equal(gradeValue(91, "A-").ok, true);
  assert.equal(gradeValue(null, "B").ok, true);
  const over = gradedPoints(21, 20);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error.kind, "earned_exceeds_possible");
  assert.equal(gradedPoints(18, 0).ok, false);
  assert.equal(gradedPoints(-1, 10).ok, false);
});

test("assignment status determines which point shapes are legal", () => {
  const base = {
    source: "powerschool" as const,
    sourceId: "ps-1",
    householdKey: "student-a",
    courseName: "Math 7",
    title: "Integer patterns",
    assignedAt: null,
    dueAt: "2026-11-06T23:59:00.000Z",
    category: "Quiz",
    url: null,
  };
  const graded = assignmentDraft({ ...base, status: "graded", earned: null, possible: 10 });
  assert.equal(graded.ok, false);
  if (!graded.ok) assert.equal(graded.error.kind, "graded_requires_points");

  const missing = assignmentDraft({ ...base, sourceId: "ps-2", status: "missing", earned: 4, possible: 10 });
  assert.equal(missing.ok, false);

  const late = assignmentDraft({ ...base, sourceId: "ps-3", status: "late", earned: 12, possible: 10 });
  assert.equal(late.ok, false);

  const assigned = assignmentDraft({ ...base, sourceId: "ps-4", status: "assigned", earned: 1, possible: 10 });
  assert.equal(assigned.ok, false);

  const okGraded = assignmentDraft({ ...base, status: "graded", earned: 18, possible: 20 });
  assert.equal(okGraded.ok, true);
  if (okGraded.ok) {
    assert.equal(okGraded.value.status, "graded");
    assert.equal(okGraded.value.points.kind, "graded");
  }

  const excused = assignmentDraft({
    ...base,
    sourceId: "ps-5",
    status: "Exempt",
    earned: null,
    possible: null,
  });
  assert.equal(excused.ok, true);
  if (excused.ok) assert.equal(excused.value.status, "excused");
});

test("names and urls reject emails and non-http schemes", () => {
  assert.equal(householdKey("student-a").ok, true);
  assert.equal(householdKey("parent@pinecrest.example").ok, false);
  assert.equal(personName("Student A", "student").ok, true);
  assert.equal(personName("a@b.com", "student").ok, false);
  assert.equal(courseName("Math 7").ok, true);
  assert.equal(httpUrl("javascript:alert(1)").ok, false);
  assert.equal(httpUrl("https://example.invalid/course").ok, true);
  assert.equal(httpUrl(null).ok, true);
});

test("due dates parse portal prose against a frozen clock", () => {
  const now = NOW.value;
  const iso = parseDue("2026-11-06", now);
  assert.equal(iso.ok && iso.value, "2026-11-06T23:59:00.000Z");
  const slash = parseDue("11/6/2026", now);
  assert.equal(slash.ok && slash.value, "2026-11-06T23:59:00.000Z");
  const long = parseDue("Friday, November 6, 2026", now);
  assert.equal(long.ok && long.value, "2026-11-06T23:59:00.000Z");
  const relative = parseDue("Friday", now);
  assert.equal(relative.ok && relative.value, "2026-11-06T23:59:00.000Z");
  assert.equal(parseDue("whenever", now).ok, false);
  const friday = instant("2026-11-06T23:59:00.000Z");
  assert.equal(friday.ok, true);
  if (friday.ok) assert.equal(weekdayShort(friday.value), "Fri");
});

test("week bounds and freshness labels stay in UTC", () => {
  const now = NOW.value;
  const week = utcWeek(now);
  assert.equal(week.start, "2026-11-02T00:00:00.000Z");
  assert.equal(week.end, "2026-11-09T00:00:00.000Z");
  assert.equal(ageLabel(addUtcDays(now, 0, 16, 0), now), "2h ago");
  assert.equal(ageLabel(now, now), "just now");
});

test("change sentences match the household feed voice", () => {
  const course = courseName("Math 7");
  const from = gradeValue(91, "A-");
  const to = gradeValue(84, "B");
  assert.equal(course.ok && from.ok && to.ok, true);
  if (!course.ok || !from.ok || !to.ok) return;
  const gradeText = describeChange({
    kind: "grade",
    id: "chg_test" as never,
    studentId: "stu_student-a" as never,
    courseId: "crs_test" as never,
    courseName: course.value,
    source: "powerschool",
    from: from.value,
    to: to.value,
    at: NOW.value,
  });
  assert.equal(gradeText, "Math 7 went from 91 to 84");
  const title = assignmentDraft({
    source: "powerschool",
    sourceId: "ps-lab",
    householdKey: "student-a",
    courseName: "Science 7",
    title: "Science lab",
    status: "assigned",
    earned: null,
    possible: 10,
    assignedAt: null,
    dueAt: "2026-11-06T23:59:00.000Z",
    category: null,
    url: null,
  });
  assert.equal(title.ok, true);
  if (!title.ok) return;
  const created = describeChange({
    kind: "assignment_new",
    id: "chg_new" as never,
    studentId: "stu_student-a" as never,
    courseId: "crs_test" as never,
    courseName: course.value,
    assignmentId: "asg_test" as never,
    title: title.value.title,
    dueAt: title.value.dueAt,
    source: "powerschool",
    at: NOW.value,
  });
  assert.equal(created, "New: Science lab due Fri");
});
