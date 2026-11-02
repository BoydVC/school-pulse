import assert from "node:assert/strict";
import { test } from "node:test";
import { seedDemo } from "../src/demo/seed.js";
import { openDatabase } from "../src/store/db.js";
import { startServer } from "../src/server/server.js";
import { fixedNow } from "./helpers.js";

test("the local API serves the household, ingest, and alerts", async () => {
  const db = openDatabase(":memory:");
  seedDemo(db, fixedNow());
  const server = await startServer({ db, host: "127.0.0.1", port: 0 });
  try {
    const health = (await fetch(`${server.url}/api/health`).then((response) => response.json())) as { ok: boolean };
    assert.equal(health.ok, true);
    const board = (await fetch(`${server.url}/api/dashboard`).then((response) => response.json())) as {
      counts: { students: number };
      tonight: { headline: string[] };
    };
    assert.equal(board.counts.students, 2);
    assert.match(board.tonight.headline.join(" · "), /missing/);

    const off = (await fetch(`${server.url}/api/alerts`).then((response) => response.json())) as { rules: unknown[]; alerts: unknown[] };
    assert.equal(off.rules.length, 0);
    assert.equal(off.alerts.length, 0);

    const page = await fetch(server.url);
    assert.match(await page.text(), /School Pulse/);

    const created = (await fetch(`${server.url}/api/alerts/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: [{ type: "grade_below", threshold: 85, enabled: true, studentName: "Student A" }] }),
    }).then((response) => response.json())) as { alerts: Array<{ summary: string }> };
    assert.equal(created.alerts.length > 0, true);
    assert.match(created.alerts[0]?.summary ?? "", /Math is 84/);

    const ingest = (await fetch(`${server.url}/api/ingest?source=generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        students: [{ sourceId: "stu-c", name: "Student C", school: "Pinecrest Middle" }],
        courses: [{ sourceId: "art", studentSourceId: "stu-c", name: "Art" }],
        assignments: [{ sourceId: "sketch", studentSourceId: "stu-c", courseSourceId: "art", title: "Sketch", status: "assigned", due: fixedNow().toISOString() }],
      }),
    }).then((response) => response.json())) as { ok: boolean; changes: Array<{ summary: string }> };
    assert.equal(ingest.ok, true);
    assert.match(ingest.changes[0]?.summary ?? "", /New: Sketch/);
  } finally {
    await server.close();
  }
});

test("sse announces an ingest", async () => {
  const db = openDatabase(":memory:");
  const server = await startServer({ db, host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    const pending = (async () => {
      while (!buffer.includes("Sketch")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value);
      }
      return buffer;
    })();
    await fetch(`${server.url}/api/ingest?source=generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        students: [{ sourceId: "stu-c", name: "Student C" }],
        courses: [{ sourceId: "art", studentSourceId: "stu-c", name: "Art" }],
        assignments: [{ sourceId: "sketch", studentSourceId: "stu-c", courseSourceId: "art", title: "Sketch", status: "assigned" }],
      }),
    });
    const text = await Promise.race([
      pending,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("sse timed out")), 4000)),
    ]);
    assert.match(text, /event: pulse/);
    assert.match(text, /Sketch/);
  } finally {
    controller.abort();
    await server.close();
  }
});
