import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { saveRules } from "../src/alerts/alerts.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { listAlerts, listAssignments, openDatabase } from "../src/store/db.js";
import { fixedNow } from "./helpers.js";

const now = fixedNow();

test("a later OneNote page marks vanished homework removed and keeps the row", () => {
  const db = openDatabase(":memory:");
  const first = ingestSnapshot(db, parseSnapshot({ source: "onenote", filename: "page.html", raw: oneNote(["Lab safety", "Microscope worksheet"]), now }), now);
  assert.equal(first.changes.map((change) => change.summary).join(" "), "baseline loaded");
  assert.equal(listAssignments(db).length, 2);
  const later = new Date(now.getTime() + 3_600_000);
  const second = ingestSnapshot(
    db,
    parseSnapshot({ source: "onenote", filename: "page.html", raw: oneNote(["Lab safety"]), now: later }),
    later,
  );
  const rows = listAssignments(db);
  assert.equal(rows.length, 2);
  const gone = rows.find((row) => row.title === "Microscope worksheet");
  const kept = rows.find((row) => row.title === "Lab safety");
  assert.equal(gone?.removed, true);
  assert.equal(kept?.removed, false);
  assert.deepEqual(
    second.changes.map((change) => change.summary),
    ["Removed: Microscope worksheet"],
  );
  const board = buildDashboard(db, later);
  assert.equal(board.tonight.items.some((item) => item.title === "Microscope worksheet"), false);
  assert.equal(board.counts.assignments, 1);
});

test("a PowerSchool scores page without a section frn fails closed", () => {
  const raw = `<html><head><title>Class Score Detail</title></head><body>
    <h1>Class Score Detail</h1>
    <table><tr><th>Due Date</th><th>Assignment</th><th>Score</th></tr>
    <tr><td>11/02/2026</td><td>Lab report</td><td>10/10</td></tr></table></body></html>`;
  assert.throws(
    () => parseSnapshot({ source: "powerschool", filename: "scores.html", raw, now }),
    /section frn/,
  );
});

test("an HTML fragment is rejected instead of becoming an empty snapshot", () => {
  assert.throws(
    () =>
      parseSnapshot({
        source: "powerschool",
        filename: "fragment.html",
        raw: "<table><tr><td>Course</td></tr><tr><td><script>alert(1)</script></td></tr></table>",
        now,
      }),
    /HTML fragment is not a saved school page/,
  );
});

test("Classroom RETURNED with assignedGrade null is excused, and a missing grade field is unknown", () => {
  const excused = parseSnapshot({
    source: "google-classroom",
    filename: "excused.json",
    raw: classroomJson({ state: "RETURNED", assignedGrade: null }),
    now,
  });
  assert.equal(excused.assignments[0]?.status, "excused");
  assert.equal(excused.assignments[0]?.pointsEarned, null);
  assert.equal(excused.notes.some((note) => /unknown/i.test(note)), false);

  const unknown = parseSnapshot({
    source: "google-classroom",
    filename: "unknown.json",
    raw: classroomJson({ state: "RETURNED" }),
    now,
  });
  assert.equal(unknown.assignments[0]?.status, "turned_in");
  assert.match(unknown.notes.join(" "), /Excused state unknown/);
});

test("missing_above states the threshold as a count", () => {
  const db = openDatabase(":memory:");
  saveRules(db, [{ type: "missing_above", threshold: 1.25, enabled: true, studentName: "Student A" }], now);
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a.json", raw: JSON.stringify(missingWork(2)), now }), now);
  assert.equal(listAlerts(db)[0]?.summary, "Student A has 2 missing, above 1.25");
});

test("the first import of any size is one baseline loaded item", () => {
  for (const count of [1, 5]) {
    const db = openDatabase(":memory:");
    const result = ingestSnapshot(
      db,
      parseSnapshot({ source: "generic", filename: "base.json", raw: JSON.stringify(missingWork(count, "assigned")), now }),
      now,
    );
    assert.deepEqual(
      result.changes.map((change) => change.summary),
      ["baseline loaded"],
    );
    assert.equal(result.changes.some((change) => change.kind === "assignment_new"), false);
  }
});

function oneNote(titles: string[], exportedAt = "2026-11-02T17:00:00.000Z"): string {
  const items = titles
    .map((title) => `<p data-tag="to-do" data-id="${title.toLowerCase().replace(/\s+/g, "-")}">${title}</p>`)
    .join("");
  return `<!DOCTYPE html><html><head>
    <meta name="school-pulse-student" content="Student A">
    <meta name="school-pulse-school" content="Pinecrest Middle">
    <meta name="school-pulse-course" content="Science">
    <meta name="school-pulse-exported-at" content="${exportedAt}">
    </head><body>${items}</body></html>`;
}

function classroomJson(submission: { state: string; assignedGrade?: number | null }): string {
  const row: { courseWorkId: string; userId: string; state: string; assignedGrade?: number | null } = {
    courseWorkId: "work-1",
    userId: "stu",
    state: submission.state,
  };
  if (Object.prototype.hasOwnProperty.call(submission, "assignedGrade")) row.assignedGrade = submission.assignedGrade ?? null;
  return JSON.stringify({
    schoolPulse: { exportedAt: "2026-11-02T17:00:00.000Z", students: { stu: { name: "Student A", school: "Pinecrest Middle" } } },
    student: { userId: "stu", fullName: "Student A", school: "Pinecrest Middle" },
    courses: { courses: [{ id: "course-1", name: "Science", courseState: "ACTIVE" }] },
    courseWork: { "course-1": { courseWork: [{ id: "work-1", title: "Lab report", state: "PUBLISHED", maxPoints: 10, dueDate: { year: 2026, month: 11, day: 6 } }] } },
    studentSubmissions: { "course-1": { studentSubmissions: [row] } },
  });
}

function missingWork(count: number, status = "missing"): unknown {
  return {
    source: "generic",
    fetchedAt: "2026-11-02T17:00:00.000Z",
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: Array.from({ length: count }, (_, index) => ({
      sourceId: `a${index}`,
      studentSourceId: "stu-a",
      courseSourceId: "math",
      title: `Worksheet ${index + 1}`,
      status,
      pointsPossible: 10,
    })),
  };
}
