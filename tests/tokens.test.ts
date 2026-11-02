import assert from "node:assert/strict";
import { test } from "node:test";
import { expandDemoTokens } from "../src/model/tokens.js";
import { zonedParts } from "../src/time/zone.js";
import { fixedNow } from "./helpers.js";

test("demo tokens stay stable for a given evening", () => {
  const now = fixedNow();
  const friday = zonedParts(new Date(expandDemoTokens("{{SP:FRIDAY}}", now)));
  assert.equal(friday.weekday, 5);
  assert.equal(friday.day, 6);
  assert.equal(friday.hour, 23);
  const today = zonedParts(new Date(expandDemoTokens("{{SP:TODAY}}", now)));
  assert.equal(today.day, 2);
  assert.equal(today.hour, 23);
  const again = expandDemoTokens("due {{SP:TODAY}}", now);
  assert.equal(again, expandDemoTokens("due {{SP:TODAY}}", new Date(now.getTime() + 60_000)));
});
