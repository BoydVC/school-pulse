import assert from "node:assert/strict";
import { test } from "node:test";
import { freshnessBadge, freshnessForAge } from "../src/model/freshness.js";
import { fixedNow } from "./helpers.js";

test("freshness flags stale sources", () => {
  assert.equal(freshnessForAge(15 * 60_000), "fresh");
  assert.equal(freshnessForAge(20 * 3_600_000), "aging");
  assert.equal(freshnessForAge(72 * 3_600_000), "stale");
  const now = fixedNow();
  assert.equal(freshnessBadge("powerschool", new Date(now.getTime() - 2 * 3_600_000).toISOString(), now).text, "PowerSchool · 2h ago");
  assert.match(freshnessBadge("onenote", new Date(now.getTime() - 72 * 3_600_000).toISOString(), now).text, /OneNote · stale · 3d ago/);
});
