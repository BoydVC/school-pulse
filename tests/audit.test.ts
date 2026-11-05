import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import {
  ensureFreshAccount,
  listAccounts,
  signInAccount,
  tokenFilePath,
  writeAccountStore,
  type AccountToken,
} from "../src/auth/accounts.js";
import { syncAccounts } from "../src/auth/sync.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { seedDemo } from "../src/demo/seed.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { startWatcher } from "../src/ingest/watch.js";
import { startServer } from "../src/server/server.js";
import { endOfDay } from "../src/model/dates.js";
import { listAssignments, openDatabase } from "../src/store/db.js";
import { civilDate, zonedTimeToUtc } from "../src/time/zone.js";
import type { DatabaseSync } from "node:sqlite";
import { attachLiveStream, shouldRefreshOnVisibility } from "../web/live.js";

const NOW = new Date("2026-11-04T21:00:00.000Z");

function ingest(db: DatabaseSync, body: unknown, now = NOW) {
  const snapshot = parseSnapshot({
    source: "generic",
    filename: "inbox/generic/feed.json",
    raw: JSON.stringify(body),
    now,
  });
  return { snapshot, result: ingestSnapshot(db, snapshot, now) };
}

function household(extra: Record<string, unknown> = {}) {
  return {
    source: "generic",
    fetchedAt: "2026-11-04T21:00:00.000Z",
    students: [
      { sourceId: "kid-1", name: "Kid One Fz" },
      { sourceId: "kid-2", name: "Kid Two Fz" },
    ],
    courses: [
      { name: "Shared Science", student: "Kid One Fz" },
      { name: "Shared Science", student: "Kid Two Fz" },
    ],
    assignments: [
      { title: "Lab One", student: "Kid One Fz", course: "Shared Science", status: "missing" },
      { title: "Lab Two", student: "Kid Two Fz", course: "Shared Science", status: "missing" },
    ],
    ...extra,
  };
}

test("a shared course name stays with the student named on the row", () => {
  const db = openDatabase(":memory:");
  ingest(db, household());
  const board = buildDashboard(db, NOW);
  const lab = board.missing.find((item) => item.title === "Lab One");
  assert.equal(lab?.studentName, "Kid One Fz");
  assert.equal(board.students.find((student) => student.name === "Kid One Fz")?.missingCount, 1);
  assert.equal(board.students.find((student) => student.name === "Kid Two Fz")?.missingCount, 1);
});

test("a course or assignment can name a student by source id", async () => {
  const db = openDatabase(":memory:");
  const server = await startServer({ db, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${server.url}/api/ingest?source=generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "generic",
        fetchedAt: NOW.toISOString(),
        students: [{ sourceId: "g1", name: "Ghost Fz" }],
        courses: [{ name: "Quiet Science", student: "g1" }],
        assignments: [{ title: "Vanished Lab", student: "g1", course: "Quiet Science", status: "missing" }],
      }),
    });
    assert.equal(response.status, 200);
    const board = buildDashboard(db, NOW);
    const item = board.missing.find((row) => row.title === "Vanished Lab");
    assert.equal(item?.studentName, "Ghost Fz");
    assert.equal(board.students.find((student) => student.name === "Ghost Fz")?.missingCount, 1);
  } finally {
    await server.close();
  }
});

test("a generic file that names nobody does not leave an empty student card", async () => {
  const db = openDatabase(":memory:");
  const server = await startServer({ db, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${server.url}/api/ingest?source=generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "generic",
        fetchedAt: NOW.toISOString(),
        students: [{ sourceId: "g1", name: "Ghost Fz" }],
        courses: [{ name: "Quiet Science", student: "missing-student" }],
        assignments: [{ title: "Vanished Lab", student: "missing-student", course: "Quiet Science", status: "missing" }],
      }),
    });
    const body = (await response.json()) as { ok?: boolean; rejected?: Array<{ reason: string }> };
    assert.notEqual(response.status, 500);
    assert.ok(response.status === 400 || (body.rejected?.length ?? 0) > 0);
    const board = buildDashboard(db, NOW);
    assert.equal(board.students.some((student) => student.name === "Ghost Fz"), false);
    assert.equal(board.missing.some((item) => item.title === "Vanished Lab"), false);
  } finally {
    await server.close();
  }
});

test("a later full snapshot drops assignments the source no longer lists", () => {
  const first = {
    source: "generic",
    fetchedAt: "2026-11-03T15:00:00.000Z",
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", student: "Kid One Fz", name: "Shared Science" }],
    assignments: [
      { sourceId: "a", title: "Lab A", student: "Kid One Fz", course: "Shared Science", status: "assigned", due: "2026-11-06T23:00:00.000Z" },
      { sourceId: "b", title: "Lab B", student: "Kid One Fz", course: "Shared Science", status: "assigned", due: "2026-11-06T23:00:00.000Z" },
      { sourceId: "c", title: "Lab C", student: "Kid One Fz", course: "Shared Science", status: "missing", due: "2026-11-01T23:00:00.000Z" },
    ],
  };
  const second = {
    ...first,
    fetchedAt: "2026-11-04T15:00:00.000Z",
    assignments: first.assignments.slice(0, 2),
  };
  for (const source of ["generic", "powerschool", "google-classroom"] as const) {
    const db = openDatabase(":memory:");
    const older = parseSnapshot({ source, filename: `${source}.json`, raw: JSON.stringify({ ...first, source }), now: NOW });
    const newer = parseSnapshot({ source, filename: `${source}.json`, raw: JSON.stringify({ ...second, source }), now: NOW });
    if (source !== "generic") {
      older.source = source;
      newer.source = source;
      older.replaceGroups = ["group-g"];
      newer.replaceGroups = ["group-g"];
      for (const assignment of [...older.assignments, ...newer.assignments]) assignment.groupKey = "group-g";
    }
    ingestSnapshot(db, older, NOW);
    const result = ingestSnapshot(db, newer, new Date("2026-11-04T15:00:00.000Z"));
    const titles = buildDashboard(db, NOW).missing.map((item) => item.title);
    assert.equal(titles.includes("Lab C"), false, source);
    assert.equal(listAssignments(db).find((item) => item.title === "Lab C")?.removed, true, source);
    assert.equal(result.changes.some((change) => change.kind === "assignment_removed" && change.summary.includes("Lab C")), true, source);
  }
});

test("assigned work due before today shows as past due and not marked", () => {
  const db = openDatabase(":memory:");
  ingest(db, {
    source: "generic",
    fetchedAt: NOW.toISOString(),
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{
      sourceId: "late-assigned",
      studentSourceId: "kid-1",
      courseSourceId: "sci",
      title: "Unmarked Packet",
      status: "assigned",
      due: "2026-11-01T22:00:00.000Z",
    }],
  });
  const board = buildDashboard(db, NOW);
  const item = board.week.overdue.find((row) => row.title === "Unmarked Packet");
  assert.ok(item);
  assert.equal(item?.dueLabel, "Past due · not marked");
  assert.equal(board.tonight.items.some((row) => row.title === "Unmarked Packet"), false);
  assert.equal(board.missing.some((row) => row.title === "Unmarked Packet"), false);
});

test("an older snapshot does not roll an assignment back to a previous status", () => {
  const db = openDatabase(":memory:");
  const body = (fetchedAt: string, status: string) => ({
    source: "generic",
    fetchedAt,
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{
      sourceId: "hw-0",
      studentSourceId: "kid-1",
      courseSourceId: "sci",
      title: "Fuzz HW 0",
      status,
      due: "2026-11-06T23:00:00.000Z",
      pointsEarned: status === "graded" ? 8 : null,
      pointsPossible: status === "graded" ? 10 : 10,
    }],
  });
  ingest(db, body("2026-11-03T12:00:00.900Z", "graded"), new Date("2026-11-03T12:00:00.900Z"));
  assert.equal(listAssignments(db).find((item) => item.title === "Fuzz HW 0")?.status, "graded");
  ingest(db, body("2026-11-03T12:00:00Z", "missing"), new Date("2026-11-04T21:00:00.000Z"));
  assert.equal(listAssignments(db).find((item) => item.title === "Fuzz HW 0")?.status, "graded");
  ingest(db, body("2026-11-02T18:40:00Z", "missing"), new Date("2026-11-04T21:00:00.000Z"));
  assert.equal(listAssignments(db).find((item) => item.title === "Fuzz HW 0")?.status, "graded");
});

test("freshness follows each student and each successful fetch", () => {
  const db = openDatabase(":memory:");
  const at = new Date("2026-11-04T21:00:00.000Z");
  const payload = (fetchedAt: string) => ({
    source: "generic",
    fetchedAt,
    students: [
      { sourceId: "kid-1", name: "Kid One Fz" },
      { sourceId: "kid-2", name: "Kid Two Fz" },
    ],
    courses: [
      { sourceId: "sci-1", studentSourceId: "kid-1", name: "Shared Science" },
      { sourceId: "sci-2", studentSourceId: "kid-2", name: "Shared Science" },
    ],
    assignments: [
      { sourceId: "a", studentSourceId: "kid-1", courseSourceId: "sci-1", title: "Lab One", status: "assigned", due: "2026-11-06T23:00:00.000Z" },
      { sourceId: "b", studentSourceId: "kid-2", courseSourceId: "sci-2", title: "Lab Two", status: "assigned", due: "2026-11-06T23:00:00.000Z" },
    ],
  });
  ingest(db, payload("2026-11-01T21:00:00.000Z"), at);
  ingest(db, {
    ...payload("2026-11-04T20:00:00.000Z"),
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci-1", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{ sourceId: "a", studentSourceId: "kid-1", courseSourceId: "sci-1", title: "Lab One", status: "assigned", due: "2026-11-06T23:00:00.000Z" }],
  }, at);
  const later = new Date(at.getTime() + 13 * 3_600_000);
  ingest(db, {
    source: "generic",
    fetchedAt: later.toISOString(),
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci-1", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{ sourceId: "a", studentSourceId: "kid-1", courseSourceId: "sci-1", title: "Lab One", status: "assigned", due: "2026-11-06T23:00:00.000Z" }],
  }, later);
  const board = buildDashboard(db, later);
  const badge = (name: string) => board.sources.find((source) => source.source === "generic" && source.text.includes(name));
  assert.equal(badge("Kid One Fz")?.state, "fresh");
  assert.equal(badge("Kid Two Fz")?.state, "stale");

  const futureDb = openDatabase(":memory:");
  ingest(futureDb, {
    source: "generic",
    fetchedAt: "2099-01-01T00:00:00.000Z",
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci-1", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{ sourceId: "a", studentSourceId: "kid-1", courseSourceId: "sci-1", title: "Lab One", status: "assigned", due: "2026-11-06T23:00:00.000Z" }],
  }, at);
  const aged = buildDashboard(futureDb, later);
  assert.equal(aged.sources.find((source) => source.text.includes("Kid One Fz"))?.state, "aging");
});

test("a reconnect and a return to the page fetch the board again", async () => {
  let refreshes = 0;
  let connected = false;
  const events = { onopen: null as (() => void) | null, onerror: null as (() => void) | null };
  const live = attachLiveStream(events, {
    refresh: () => {
      refreshes += 1;
    },
    setConnected: (on) => {
      connected = on;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  events.onopen?.();
  await settle();
  assert.equal(connected, true);
  assert.equal(refreshes, 1);
  events.onerror?.();
  assert.equal(connected, false);
  events.onopen?.();
  await settle();
  assert.equal(refreshes, 2);
  assert.equal(connected, true);
  live.close();
  assert.equal(shouldRefreshOnVisibility("visible"), true);
  assert.equal(shouldRefreshOnVisibility("hidden"), false);
});

test("a dropped token request keeps the account and a later refresh still works", async () => {
  const expired = account({
    accountKey: "student.a@example.com",
    email: "student.a@example.com",
    studentId: "stu-a",
    access_token: "access-old",
    refresh_token: "synthetic-refresh",
    expires_at: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  let failures = 0;
  await assert.rejects(
    () => ensureFreshAccount({
      account: expired,
      kind: "classroom",
      clientId: "desktop-client",
      now: NOW,
      fetchImpl: async () => {
        failures += 1;
        throw new Error("ECONNRESET");
      },
    }),
    /ECONNRESET/,
  );
  assert.equal(failures > 1, true);
  assert.equal(expired.reauth_needed, false);
  const refreshed = await ensureFreshAccount({
    account: expired,
    kind: "classroom",
    clientId: "desktop-client",
    now: NOW,
    fetchImpl: async () => jsonResponse(200, { access_token: "access-new", expires_in: 3600, token_type: "Bearer" }),
  });
  assert.equal(refreshed.access_token, "access-new");
  assert.equal(refreshed.reauth_needed, false);

  const directory = mkdtempSync(join(tmpdir(), "school-pulse-retry-"));
  writeAccountStore(tokenFilePath(directory, "classroom"), { version: 2, accounts: { [expired.accountKey]: expired } });
  const db = openDatabase(join(directory, "school-pulse.sqlite"));
  const failed = await syncAccounts({
    dataDir: directory,
    db,
    now: NOW,
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
    env: { SCHOOL_PULSE_GOOGLE_CLIENT_ID: "desktop-client" },
  });
  assert.match(failed.messages.join("\n"), /will retry/);
  assert.equal(listAccounts(tokenFilePath(directory, "classroom"))[0]?.reauth_needed, false);
  assert.equal(failed.messages.some((message) => message.includes("re-auth needed")), false);
});

test("signing the same account in for a second student does not move the token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-reassign-"));
  const storePath = tokenFilePath(directory, "classroom");
  const tokenServer = await tokenEndpoint({
    "code-a": { access: "access-a", refresh: "refresh-a", email: "student.a@example.com" },
    "code-b": { access: "access-b", refresh: "refresh-b", email: "student.a@example.com" },
  });
  const sign = (studentId: string, code: string, reassign = false) => signInAccount({
    kind: "classroom",
    clientId: "desktop-client",
    studentId,
    storePath,
    reassign,
    tokenUrl: tokenServer.url,
    timeoutMs: 5000,
    fetchImpl: fetch,
    onAuthorizeUrl: (url) => {
      const parsed = new URL(url);
      void fetch(`${parsed.searchParams.get("redirect_uri")}?code=${code}&state=${parsed.searchParams.get("state")}`);
    },
  });
  try {
    await sign("stu-a", "code-a");
    await assert.rejects(() => sign("stu-b", "code-b"), /stu-a/);
    const stored = listAccounts(storePath);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.studentId, "stu-a");
    assert.equal(stored[0]?.access_token, "access-a");
    await sign("stu-b", "code-b", true);
    const moved = listAccounts(storePath);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.studentId, "stu-b");
    assert.equal(moved[0]?.access_token, "access-b");
  } finally {
    await tokenServer.close();
  }
});

test("bad ingest and alert input is rejected instead of failing the request", async () => {
  const db = openDatabase(":memory:");
  const server = await startServer({ db, host: "127.0.0.1", port: 0 });
  try {
    const empty = await fetch(`${server.url}/api/ingest?source=generic`, { method: "POST", body: "" });
    assert.equal(empty.status, 400);

    const unknown = await fetch(`${server.url}/api/ingest?source=generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "generic",
        fetchedAt: NOW.toISOString(),
        students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
        courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
        assignments: [
          { sourceId: "ok", studentSourceId: "kid-1", courseSourceId: "sci", title: "Kept Lab", status: "assigned", due: NOW.toISOString() },
          { title: "Missing Course Lab", student: "Kid One Fz", course: "No Such Course", status: "assigned" },
        ],
      }),
    });
    const unknownBody = (await unknown.json()) as { rejected?: Array<{ reason: string }> };
    assert.notEqual(unknown.status, 500);
    assert.ok(unknown.status === 400 || (unknownBody.rejected?.some((row) => /course/i.test(row.reason)) ?? false));
    const board = buildDashboard(db, NOW);
    assert.equal(board.tonight.items.some((item) => item.title === "Missing Course Lab") || board.week.days.some((day) => day.items.some((item) => item.title === "Missing Course Lab")), false);
    assert.equal(
      board.tonight.items.some((item) => item.title === "Kept Lab") || unknown.status === 400,
      true,
    );

    const rules = await fetch(`${server.url}/api/alerts/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(rules.status, 400);

    const webhook = await fetch(`${server.url}/api/alerts/webhook`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://files.example.test/hook" }),
    });
    assert.equal(webhook.status, 400);
  } finally {
    await server.close();
  }
});

test("the missing tab count matches the missing page", () => {
  const db = openDatabase(":memory:");
  seedDemo(db, new Date(2026, 10, 2, 17, 30, 0, 0));
  const board = buildDashboard(db, new Date(2026, 10, 2, 17, 30, 0, 0));
  assert.equal(board.missing.some((item) => item.status === "late"), true);
  assert.equal(board.missing.some((item) => item.status === "missing"), true);
  assert.equal(board.counts.missing, board.missing.length);
});

test("one bad token entry does not hide the other students", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-tokens-"));
  const path = tokenFilePath(directory, "classroom");
  mkdirSync(join(directory, "tokens"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 2,
    accounts: {
      good: account({
        accountKey: "student.a@example.com",
        email: "student.a@example.com",
        studentId: "stu-a",
        access_token: "access-a",
        expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
      }),
      broken: { accountKey: "student.b@example.com", studentId: "../../..", access_token: "access-b", refresh_token: "refresh-b" },
    },
  }, null, 2)}\n`);
  const stored = listAccounts(path);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.studentId, "stu-a");
  const db = openDatabase(join(directory, "school-pulse.sqlite"));
  const result = await syncAccounts({
    dataDir: directory,
    db,
    now: NOW,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/courses?")) {
        return jsonResponse(200, { courses: [{ id: "course-a", name: "English", courseState: "ACTIVE" }] });
      }
      if (url.includes("/courseWork?")) return jsonResponse(200, { courseWork: [] });
      if (url.includes("/userProfiles/me")) return jsonResponse(200, { id: "ga", name: { fullName: "Student A" } });
      return jsonResponse(200, {});
    },
    env: { SCHOOL_PULSE_GOOGLE_CLIENT_ID: "desktop-client" },
  });
  assert.match(result.messages.join("\n"), /skipped unreadable account/);
  assert.equal(result.messages.some((message) => /every student|not a School Pulse token store|unreadable account "good"/i.test(message)), false);
});

test("files already in the inbox are imported when the watcher starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "school-pulse-sweep-"));
  const db = openDatabase(join(dir, "school-pulse.sqlite"));
  const inbox = join(dir, "inbox", "generic");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, "waiting.json"), JSON.stringify({
    source: "generic",
    fetchedAt: NOW.toISOString(),
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{ sourceId: "gap", studentSourceId: "kid-1", courseSourceId: "sci", title: "Gap Item", status: "assigned", due: "2026-11-06T23:00:00.000Z" }],
  }));
  const watcher = startWatcher({ dataDir: dir, db });
  try {
    const deadline = Date.now() + 4000;
    while (!listAssignments(db).some((item) => item.title === "Gap Item") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(listAssignments(db).some((item) => item.title === "Gap Item"), true);
  } finally {
    watcher.close();
  }
});

test("month-day, weekday, and yearless dates keep a due date", () => {
  const db = openDatabase(":memory:");
  const { snapshot } = ingest(db, {
    source: "generic",
    fetchedAt: "2026-11-04T21:00:00.000Z",
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [
      { sourceId: "md", studentSourceId: "kid-1", courseSourceId: "sci", title: "Slash Day", status: "assigned", due: "11/2" },
      { sourceId: "named", studentSourceId: "kid-1", courseSourceId: "sci", title: "Named Day", status: "assigned", due: "Nov 2" },
      { sourceId: "weekday", studentSourceId: "kid-1", courseSourceId: "sci", title: "Weekday Lab", status: "assigned", due: "Monday" },
    ],
  });
  const dueOf = (title: string) => snapshot.assignments.find((item) => item.title === title)?.due ?? "";
  assert.equal(civilDate(new Date(dueOf("Slash Day"))), "2026-11-02");
  assert.equal(civilDate(new Date(dueOf("Named Day"))), "2026-11-02");
  assert.equal(civilDate(new Date(dueOf("Weekday Lab"))), "2026-11-09");
  const board = buildDashboard(db, NOW);
  assert.equal(board.week.overdue.some((item) => item.title === "Slash Day"), true);
  assert.equal(board.week.overdue.some((item) => item.title === "Named Day"), true);
});

test("a due time in the last minute of the household day still counts as tonight", () => {
  const now = new Date("2026-11-02T22:00:00.000Z");
  const db = openDatabase(":memory:");
  ingest(db, {
    source: "generic",
    fetchedAt: now.toISOString(),
    students: [{ sourceId: "kid-1", name: "Kid One Fz" }],
    courses: [{ sourceId: "sci", studentSourceId: "kid-1", name: "Shared Science" }],
    assignments: [{
      sourceId: "last",
      studentSourceId: "kid-1",
      courseSourceId: "sci",
      title: "Last Minute Lab",
      status: "assigned",
      due: "2026-11-03T04:59:30.000Z",
    }],
  }, now);
  const board = buildDashboard(db, now);
  const item = board.tonight.items.find((row) => row.title === "Last Minute Lab");
  assert.ok(item);
  assert.equal(item?.dueLabel, "Due tonight");
  assert.equal(board.tonight.detail.includes("Next up"), false);
  const lastMinute = zonedTimeToUtc({ year: 2026, month: 11, day: 2, hour: 23, minute: 59, second: 30 }, "America/New_York");
  assert.equal(lastMinute.getTime() <= endOfDay(now).getTime(), true);
});

function account(partial: Partial<AccountToken> & Pick<AccountToken, "accountKey" | "studentId" | "access_token">): AccountToken {
  return {
    email: partial.email ?? null,
    accountId: partial.accountId ?? null,
    refresh_token: partial.refresh_token === undefined ? "synthetic-refresh" : partial.refresh_token,
    token_type: "Bearer",
    scope: "openid email",
    expires_at: partial.expires_at === undefined ? new Date(NOW.getTime() + 3_600_000).toISOString() : partial.expires_at,
    reauth_needed: partial.reauth_needed ?? false,
    reauth_reason: partial.reauth_reason ?? null,
    updated_at: NOW.toISOString(),
    accountKey: partial.accountKey,
    studentId: partial.studentId,
    access_token: partial.access_token,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenEndpoint(issued: Record<string, { access: string; refresh: string; email: string }>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const code = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("code") ?? "";
        const row = issued[code];
        if (!row) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: row.access,
          refresh_token: row.refresh,
          expires_in: 3600,
          token_type: "Bearer",
          id_token: jwt({ exp: 1_900_000_000, email: row.email, sub: "10001" }),
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/token`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}
