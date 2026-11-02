import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { openDatabase } from "../src/store/db.js";
import { activeTimezone, civilDate, DEFAULT_TIMEZONE, zonedParts } from "../src/time/zone.js";

const now = new Date("2026-11-02T22:30:00.000Z");

test("the default household zone is America/New_York even when the process clock is UTC", () => {
  const previous = process.env.SCHOOL_PULSE_TZ;
  delete process.env.SCHOOL_PULSE_TZ;
  delete process.env.SCHOOL_PULSE_TIMEZONE;
  assert.equal(activeTimezone(), DEFAULT_TIMEZONE);
  assert.equal(DEFAULT_TIMEZONE, "America/New_York");
  assert.equal(civilDate(now), "2026-11-02");
  assert.equal(zonedParts(new Date("2026-11-03T04:30:00.000Z")).day, 2);
  assert.equal(zonedParts(new Date("2026-11-03T05:00:00.000Z")).day, 3);
  if (previous === undefined) delete process.env.SCHOOL_PULSE_TZ;
  else process.env.SCHOOL_PULSE_TZ = previous;
});

test("tonight and this week follow America/New_York across the UTC date line", () => {
  const previous = process.env.SCHOOL_PULSE_TZ;
  process.env.SCHOOL_PULSE_TZ = "America/New_York";
  const db = openDatabase(":memory:");
  ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "edge.json", raw: JSON.stringify(edge()), now }), now);
  const board = buildDashboard(db, now);
  const titles = (label: string) => board.week.days.find((day) => day.label === label)?.items.map((item) => item.title) ?? [];
  assert.deepEqual(titles("Today"), ["Night boundary"]);
  assert.equal(titles("Tomorrow").includes("Night boundary"), false);
  assert.equal(board.week.days.some((day) => day.items.some((item) => item.title === "Sunday night local")), false);
  assert.equal(board.tonight.items.some((item) => item.title === "Night boundary"), true);
  assert.equal(board.timezone, "America/New_York");
  if (previous === undefined) delete process.env.SCHOOL_PULSE_TZ;
  else process.env.SCHOOL_PULSE_TZ = previous;
});

test("fall-back and spring-forward still land on the local calendar day", () => {
  const beforeFallBack = new Date("2026-11-01T05:30:00.000Z");
  const afterFallBack = new Date("2026-11-01T06:30:00.000Z");
  assert.equal(civilDate(beforeFallBack, "America/New_York"), "2026-11-01");
  assert.equal(civilDate(afterFallBack, "America/New_York"), "2026-11-01");
  assert.equal(zonedParts(beforeFallBack, "America/New_York").hour, 1);
  assert.equal(zonedParts(afterFallBack, "America/New_York").hour, 1);
  const afterSpring = new Date("2026-03-08T07:30:00.000Z");
  assert.equal(civilDate(afterSpring, "America/New_York"), "2026-03-08");
  assert.equal(zonedParts(afterSpring, "America/New_York").hour, 3);
});

function edge(): unknown {
  return {
    source: "generic",
    fetchedAt: now.toISOString(),
    students: [{ sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: [
      {
        sourceId: "night",
        studentSourceId: "stu-a",
        courseSourceId: "math",
        title: "Night boundary",
        due: "2026-11-03T03:30:00.000Z",
        status: "assigned",
        pointsPossible: 10,
      },
      {
        sourceId: "sunday",
        studentSourceId: "stu-a",
        courseSourceId: "math",
        title: "Sunday night local",
        due: "2026-11-02T04:30:00.000Z",
        status: "assigned",
        pointsPossible: 10,
      },
    ],
  };
}
