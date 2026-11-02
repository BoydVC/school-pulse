import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { deliverWebhooks, evaluateAlerts, readAlerts, saveRules, setWebhook } from "../src/alerts/alerts.js";
import { ingestSnapshot } from "../src/ingest/ingest.js";
import { listAlerts, openDatabase } from "../src/store/db.js";
import { fixedNow } from "./helpers.js";

const now = fixedNow();

test("alerts stay off until a rule is enabled", () => {
  const db = openDatabase(":memory:");
  load(db, 70);
  assert.equal(evaluateAlerts(db, now).length, 0);
  assert.equal(readAlerts(db, now).rules.length, 0);
});

test("grade_below, missing_above, and grade_drop each fire once", () => {
  const db = openDatabase(":memory:");
  load(db, 91);
  saveRules(
    db,
    [
      { type: "grade_below", threshold: 80, enabled: true },
      { type: "missing_above", threshold: 0, enabled: true, studentName: "Student A" },
      { type: "grade_drop", threshold: 5, enabled: true },
    ],
    now,
  );
  load(db, 70, true);
  const alerts = listAlerts(db).map((alert) => alert.summary).sort();
  assert.equal(alerts.length, 3);
  assert.match(alerts[0] ?? "", /Math dropped 21 points/);
  assert.match(alerts[1] ?? "", /Math is 70/);
  assert.match(alerts[2] ?? "", /Student A has 1 missing/);
  load(db, 70, true);
  assert.equal(listAlerts(db).length, 3);
});

test("a disabled rule does not fire", () => {
  const db = openDatabase(":memory:");
  saveRules(db, [{ type: "grade_below", threshold: 100, enabled: false }], now);
  load(db, 70);
  assert.equal(listAlerts(db).length, 0);
});

test("webhooks receive the alert payload", async () => {
  const db = openDatabase(":memory:");
  const body = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.end("ok");
        resolve(Buffer.concat(chunks).toString("utf8"));
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      setWebhook(db, `http://127.0.0.1:${address.port}/hook`);
      saveRules(db, [{ type: "grade_below", threshold: 80, enabled: true }], now);
      const result = load(db, 70);
      void deliverWebhooks(db, result.alerts).catch(reject);
    });
  });
  assert.match(body, /Math is 70/);
});

function load(db: ReturnType<typeof openDatabase>, percent: number, missing = false) {
  const raw = JSON.stringify({
    students: [{ sourceId: "stu-a", name: "Student A" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: [
      {
        sourceId: "lab",
        studentSourceId: "stu-a",
        courseSourceId: "math",
        title: "Lab report",
        status: missing ? "missing" : "assigned",
      },
    ],
    grades: [{ studentSourceId: "stu-a", courseSourceId: "math", percent, asOf: missing ? "2026-11-02T18:00:00.000Z" : "2026-11-01T16:00:00.000Z" }],
  });
  return ingestSnapshot(db, parseSnapshot({ source: "generic", filename: "a.json", raw, now }), now);
}
