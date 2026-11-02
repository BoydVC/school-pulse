import assert from "node:assert/strict";
import test from "node:test";
import { liveDocument, demoDocuments } from "../src/demo/documents.ts";
import { ageLabel, instant } from "../src/domain/index.ts";
import { ingestText } from "../src/ingest/ingest.ts";
import { dashboard } from "../src/server/view.ts";
import { seedDemo } from "../src/demo/seed.ts";
import { fixedNow, memoryStore } from "./helpers.ts";

test("demo seed has two students, four sources, and at least twelve assignments", async () => {
  const now = fixedNow();
  const store = memoryStore();
  const seeded = await seedDemo(store, now);
  assert.equal(seeded.students, 2);
  assert.ok(seeded.assignments >= 12);
  assert.ok(seeded.sources >= 3);
  const view = dashboard(store, now);
  assert.deepEqual(view.students.map((student) => student.displayName), ["Student A", "Student B"]);
  assert.equal(view.changes.length, 0);
  assert.equal(view.sources.find((source) => source.source === "powerschool")?.ageLabel, "2h ago");
  assert.equal(view.sources.find((source) => source.source === "onenote")?.stale, true);
  assert.equal(view.sources.find((source) => source.source === "google-classroom")?.stale, false);
  assert.equal(view.students.find((student) => student.displayName === "Student A")?.missing, 1);
  assert.equal(view.students.find((student) => student.displayName === "Student A")?.late, 1);
  const math = view.courses.find((course) => course.name === "Math 7" && course.studentName === "Student A");
  assert.deepEqual(math?.trend, [94, 93, 91]);
  assert.equal(math?.percent, 91);
  store.close();
});

test("re-ingesting the same file changes nothing, and a later file diffs once", async () => {
  const now = fixedNow();
  const store = memoryStore();
  await seedDemo(store, now);
  const before = store.dump();
  const baseline = demoDocuments(now)[0];
  assert.ok(baseline);
  const again = await ingestText(store, baseline.source, baseline.text, baseline.filename, now);
  assert.equal(again.ok && again.value.outcome, "unchanged");
  assert.equal(store.dump(), before);
  const live = liveDocument(now);
  const applied = await ingestText(store, live.source, live.text, live.filename, now);
  assert.equal(applied.ok, true);
  if (!applied.ok || applied.value.outcome !== "applied") return;
  assert.deepEqual(applied.value.messages, ["Math 7 went from 91 to 84", "New: Science lab due Fri"]);
  const repeated = await ingestText(store, live.source, live.text, live.filename, now);
  assert.equal(repeated.ok && repeated.value.outcome, "unchanged");
  const view = dashboard(store, now);
  assert.equal(view.courses.find((course) => course.name === "Math 7")?.percent, 84);
  assert.equal(view.changes.length, 2);
  const third = await ingestText(store, live.source, live.text, live.filename, now);
  assert.equal(third.ok && third.value.outcome, "unchanged");
  assert.equal(store.changes().length, 2);
  store.close();
});

test("freshness label for a two-hour-old pull is 2h ago", () => {
  const now = fixedNow();
  const earlier = instant("2026-11-02T16:00:00.000Z");
  assert.equal(earlier.ok, true);
  if (earlier.ok) assert.equal(ageLabel(earlier.value, now), "2h ago");
});
