import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { saveRules } from "../src/alerts/alerts.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { title } from "../src/domain/brand.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { startServer } from "../src/server/server.js";
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

test("assignment titles may contain quotes and other printable characters", () => {
  const accepted = [
    '"Poem Title" Analysis',
    "Leyendo en clase, ¿Cómo estás?",
    'Vocabulary Quiz "The Story..."',
    "Vocabulary Quiz \u201CThe Story\u2026\u201D",
    "Maps & charts!",
    "Q".repeat(160),
  ];
  for (const value of accepted) {
    const parsed = title(value);
    assert.equal(parsed.ok, true, value);
    if (parsed.ok) assert.equal(parsed.value, value);
  }
  assert.equal(title(" Poem").ok, false);
  assert.equal(title("Worksheet @ home").ok, false);
  assert.equal(title("Quiz\n2").ok, false);
  assert.equal(title("").ok, false);
  assert.equal(title("Q".repeat(161)).ok, false);
});

test("a bad generic row is skipped, reported, and logged while the rest is ingested", async () => {
  const raw = JSON.stringify({
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: [
      { sourceId: "poem", studentSourceId: "stu-a", courseSourceId: "math", title: '"Poem Title" Analysis', status: "assigned" },
      { sourceId: "secret", studentSourceId: "stu-a", courseSourceId: "math", title: "Secret note", status: "lost" },
      { sourceId: "mail", studentSourceId: "stu-a", courseSourceId: "math", title: "Tell mom@home", status: "assigned" },
      { sourceId: "read", studentSourceId: "stu-a", courseSourceId: "math", title: "Leyendo en clase, ¿Cómo estás?", status: "assigned" },
      { sourceId: "quiz", studentSourceId: "stu-a", courseSourceId: "math", title: 'Vocabulary Quiz "The Story..."', status: "assigned" },
    ],
  });
  const logs: string[] = [];
  const original = console.error;
  console.error = (message?: unknown, ...rest: unknown[]) => {
    logs.push([message, ...rest].map((part) => String(part)).join(" "));
  };
  try {
    const db = openDatabase(":memory:");
    const result = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "mixed.json", raw, now }), now);
    assert.deepEqual(
      result.rejected.map((row) => row.index),
      [1, 2],
    );
    assert.match(result.rejected[0]?.reason ?? "", /Unknown assignment status "lost"/);
    assert.match(result.rejected[1]?.reason ?? "", /mom@home/);
    assert.equal(result.assignmentsInserted, 3);
    assert.deepEqual(
      listAssignments(db).map((row) => row.title).sort(),
      ['"Poem Title" Analysis', "Leyendo en clase, ¿Cómo estás?", 'Vocabulary Quiz "The Story..."'].sort(),
    );
    assert.equal(logs.some((line) => line.startsWith("Rejected row 1:")), true);
    assert.equal(logs.some((line) => line.startsWith("Rejected row 2:")), true);

    const server = await startServer({ db: openDatabase(":memory:"), host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.url}/api/ingest?source=generic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const body = (await response.json()) as { ok: boolean; assignmentsInserted: number; rejected: Array<{ index: number; reason: string }> };
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.assignmentsInserted, 3);
      assert.deepEqual(body.rejected.map((row) => row.index), [1, 2]);
    } finally {
      await server.close();
    }
  } finally {
    console.error = original;
  }
});

test("a second student's first file is one baseline loaded item", () => {
  const db = openDatabase(":memory:");
  const first = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a.json", raw: JSON.stringify(studentWork("stu-a", "Student A", 2)), now }), now);
  assert.deepEqual(first.changes.map((change) => change.summary), ["baseline loaded"]);
  const second = ingestSnapshot(
    db,
    parseSnapshot({ source: "generic", filename: "b.json", raw: JSON.stringify(studentWork("stu-b", "Student B", 3)), now }),
    now,
  );
  assert.deepEqual(second.changes.map((change) => change.summary), ["baseline loaded"]);
  assert.equal(second.changes.some((change) => change.summary.startsWith("New:")), false);
  assert.equal(listAssignments(db).length, 5);
  const extra = studentWork("stu-a", "Student A", 1, "Extra credit") as {
    assignments: Array<{ sourceId: string }>;
  };
  extra.assignments[0]!.sourceId = "stu-a-extra";
  const later = ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a2.json", raw: JSON.stringify(extra), now }), now);
  assert.deepEqual(later.changes.map((change) => change.summary), ["New: Extra credit"]);
});

function studentWork(sourceId: string, name: string, count: number, title = "Worksheet"): unknown {
  return {
    source: "generic",
    fetchedAt: "2026-11-02T17:00:00.000Z",
    students: [{ sourceId, name, school: "Pinecrest Middle" }],
    courses: [{ sourceId: `${sourceId}-math`, studentSourceId: sourceId, name: "Math" }],
    assignments: Array.from({ length: count }, (_, index) => ({
      sourceId: `${sourceId}-${index}`,
      studentSourceId: sourceId,
      courseSourceId: `${sourceId}-math`,
      title: count === 1 ? title : `${title} ${index + 1}`,
      status: "assigned",
    })),
  };
}

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
