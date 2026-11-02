import assert from "node:assert/strict";
import test from "node:test";
import { liveDocument } from "../src/demo/documents.ts";
import { join } from "node:path";
import { packageRoot } from "../src/paths.ts";
import { seedDemo } from "../src/demo/seed.ts";
import { startServer } from "../src/server/http.ts";
import { fixedNow, memoryStore } from "./helpers.ts";

test("household API, idempotent ingest, and SSE show a live update", { timeout: 15000 }, async () => {
  const now = fixedNow();
  const store = memoryStore();
  await seedDemo(store, now);
  const server = await startServer({
    store,
    port: 0,
    publicDir: join(packageRoot(), "public"),
    now: () => now,
  });
  const health = await fetch(`${server.url}/api/health`);
  assert.equal(health.status, 200);
  const page = await fetch(server.url);
  assert.match(await page.text(), /School Pulse/);
  const household = await fetch(`${server.url}/api/household`).then((response) => response.json() as Promise<{ students: { displayName: string }[]; assignments: unknown[] }>);
  assert.equal(household.students.length, 2);
  assert.ok(household.assignments.length >= 12);

  const controller = new AbortController();
  const events = await fetch(`${server.url}/api/events`, { signal: controller.signal });
  const reader = events.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  while (reader && !buffer.includes(": connected")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value);
  }
  const read = (async () => {
    while (reader && !buffer.includes("event: ingest")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value);
    }
  })();
  const live = liveDocument(now);
  const posted = await fetch(`${server.url}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: live.source, filename: live.filename, text: live.text }),
  });
  const body = await posted.json() as { outcome?: string; messages?: string[] };
  assert.equal(body.outcome, "applied");
  assert.deepEqual(body.messages, ["Math 7 went from 91 to 84", "New: Science lab due Fri"]);
  const duplicate = await fetch(`${server.url}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: live.source, filename: live.filename, text: live.text }),
  });
  const duplicateBody = await duplicate.json() as { outcome?: string };
  assert.equal(duplicateBody.outcome, "unchanged");
  await read;
  assert.match(buffer, /Math 7 went from 91 to 84/);
  controller.abort();
  await server.close();
  store.close();
});
