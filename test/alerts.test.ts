import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { liveDocument } from "../src/demo/documents.ts";
import { ingestText } from "../src/ingest/ingest.ts";
import { seedDemo } from "../src/demo/seed.ts";
import { fixedNow, memoryStore } from "./helpers.ts";

test("alerts stay off until a rule and webhook are enabled", async () => {
  const now = fixedNow();
  const store = memoryStore();
  await seedDemo(store, now);
  const live = liveDocument(now);
  const first = await ingestText(store, live.source, live.text, live.filename, now);
  assert.equal(first.ok, true);
  if (!first.ok || first.value.outcome !== "applied") return;
  assert.equal(first.value.alerts.length, 0);
  assert.equal(store.alerts().length, 0);
  assert.equal(store.rules().every((rule) => rule.enabled === false), true);

  const posts: string[] = [];
  const hook = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", () => resolve()));
  const address = hook.address();
  if (!address || typeof address === "string") throw new Error("hook");
  store.saveRules([
    { kind: "grade_below", enabled: false, threshold: 70 },
    { kind: "missing_above", enabled: true, count: 0 },
    { kind: "grade_drop", enabled: true, points: 5 },
  ]);
  store.setWebhook(`http://127.0.0.1:${address.port}/hook`, true);
  const followUp = live.text.replace('"percent": 84', '"percent": 70').replace(live.filename, "follow-up");
  const secondName = "powerschool-follow-up.json";
  const second = await ingestText(store, "powerschool", followUp, secondName, now);
  assert.equal(second.ok, true);
  if (second.ok && second.value.outcome === "applied") {
    assert.ok(second.value.alerts.some((alert) => alert.kind === "grade_drop"));
    assert.ok(second.value.alerts.some((alert) => alert.kind === "missing_above"));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(posts.join("\n"), /Math 7 dropped from 84 to 70/);
  hook.close();
  store.close();
});
