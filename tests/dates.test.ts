import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDueLabel, formatDuePhrase, formatWhen, isSameDay, parseLooseDate, startOfWeek } from "../src/model/dates.js";
import { zonedParts } from "../src/time/zone.js";
import { fixedNow } from "./helpers.js";

const now = fixedNow();
const zone = "America/New_York";

test("Monday Nov 2 2026 is the household clock used by fixtures", () => {
  const parts = zonedParts(now, zone);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 2);
  assert.equal(parts.weekday, 1);
});

test("parses school date phrases relative to tonight", () => {
  assert.equal(isSameDay(parseLooseDate("tonight", now)!, now, zone), true);
  assert.equal(isSameDay(parseLooseDate("tomorrow", now)!, new Date("2026-11-03T18:00:00.000Z"), zone), true);
  assert.equal(isSameDay(parseLooseDate("Friday", now)!, new Date("2026-11-06T18:00:00.000Z"), zone), true);
  assert.equal(isSameDay(parseLooseDate("Friday, Nov 6", now)!, new Date("2026-11-06T18:00:00.000Z"), zone), true);
  assert.equal(isSameDay(parseLooseDate("11/3/2026", now)!, new Date("2026-11-03T18:00:00.000Z"), zone), true);
  assert.equal(isSameDay(parseLooseDate("Nov 6, 2026", now)!, new Date("2026-11-06T18:00:00.000Z"), zone), true);
  assert.equal(parseLooseDate("2026-11-06T23:59:00.000Z", now)?.toISOString(), "2026-11-06T23:59:00.000Z");
});

test("due phrases sound like an evening", () => {
  const tonight = parseLooseDate("tonight", now)!.toISOString();
  const tomorrow = parseLooseDate("tomorrow", now)!.toISOString();
  const friday = parseLooseDate("Friday", now)!.toISOString();
  assert.equal(formatDuePhrase(tonight, now), "tonight");
  assert.equal(formatDuePhrase(tomorrow, now), "tomorrow");
  assert.equal(formatDuePhrase(friday, now), "Fri");
  assert.equal(formatDueLabel(tonight, "assigned", now), "Due tonight");
  assert.equal(formatDueLabel(parseLooseDate("2026-10-30", now)!.toISOString(), "missing", now), "3 days late");
  assert.equal(formatDueLabel(parseLooseDate("yesterday", now)!.toISOString(), "late", now), "1 day late");
});

test("the week starts Monday", () => {
  const start = zonedParts(startOfWeek(now, zone), zone);
  assert.equal(start.weekday, 1);
  assert.equal(start.day, 2);
  assert.equal(start.hour, 0);
});

test("relative times stay short", () => {
  assert.equal(formatWhen(new Date(now.getTime() - 15 * 60_000).toISOString(), now), "15m ago");
  assert.equal(formatWhen(new Date(now.getTime() - 2 * 3_600_000).toISOString(), now), "2h ago");
  assert.equal(formatWhen(new Date(now.getTime() - 3 * 86_400_000).toISOString(), now), "3d ago");
});
