import assert from "node:assert/strict";
import { test } from "node:test";
import { expandDemoTokens } from "../src/model/tokens.js";
import { fixedNow } from "./helpers.js";

test("demo tokens stay stable for a given evening", () => {
  const now = fixedNow();
  const friday = new Date(expandDemoTokens("{{SP:FRIDAY}}", now));
  assert.equal(friday.getDay(), 5);
  assert.equal(friday.getDate(), 6);
  const today = new Date(expandDemoTokens("{{SP:TODAY}}", now));
  assert.equal(today.getDate(), 2);
  assert.equal(today.getHours(), 23);
  const again = expandDemoTokens("due {{SP:TODAY}}", now);
  assert.equal(again, expandDemoTokens("due {{SP:TODAY}}", new Date(now.getTime() + 60_000)));
});
