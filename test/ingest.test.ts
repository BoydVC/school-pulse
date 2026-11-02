import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { evaluateAlerts } from '../src/alerts.js';
import { ingestFile, ingestInbox } from '../src/ingest.js';
import { seedDemoInbox } from '../src/demo.js';
import { openStore } from '../src/store.js';
import { startServer } from '../src/server.js';

const fixture = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('re-ingesting the same files changes nothing and builds the household', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
  const inbox = join(dir, 'inbox');
  seedDemoInbox(inbox);
  const store = openStore(join(dir, 'school-pulse.sqlite'));
  const first = ingestInbox(store, inbox);
  assert.equal(first.some((report) => report.error), false, first.map((report) => report.error).join('\n'));
  const before = store.snapshot();
  const state = store.state(new Date('2026-11-02T17:11:00Z'));
  assert.equal(state.students.length, 2);
  assert.ok(state.assignments.filter((item) => !item.dropped).length >= 12);
  const sources = new Set(state.assignments.map((item) => item.source));
  assert.ok(sources.has('powerschool') && sources.has('onenote') && sources.has('google-classroom'));
  const math = state.students.find((student) => student.name === 'Student A')?.courses.find((course) => course.name === 'Math' && course.source === 'powerschool');
  assert.deepEqual(math?.trend, [94, 91, 84]);
  assert.equal(math?.percent, 84);
  assert.equal(math?.letter, 'B');
  assert.ok(state.changes.some((change) => change.summary === 'Math went from 91 to 84'));
  const onenote = state.freshness.find((item) => item.source === 'onenote');
  assert.equal(onenote?.stale, true);
  const second = ingestInbox(store, inbox);
  assert.ok(second.every((report) => report.unchanged));
  assert.equal(store.snapshot(), before);
  assert.equal(store.state(new Date('2026-11-02T17:11:00Z')).changes.length, state.changes.length);
  store.close();
});

test('a newer identical export refreshes freshness without a new change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
  const store = openStore(':memory:');
  const file = join(dir, 'advisory.json');
  writeFileSync(file, fixture('fixtures/generic/advisory.json'));
  const first = ingestFile(store, file);
  assert.equal(first.unchanged, false);
  const changed = first.changes.length;
  const tweaked = fixture('fixtures/generic/advisory.json').replace('2026-11-02T16:50:00Z', '2026-11-03T16:50:00Z');
  const next = join(dir, 'advisory-2.json');
  writeFileSync(next, tweaked);
  const second = ingestFile(store, next);
  assert.equal(second.changes.length, 0);
  assert.ok((second.result?.refreshed ?? 0) > 0);
  assert.equal(store.state(new Date('2026-11-03T18:00:00Z')).changes.length, changed);
  store.close();
});

test('an older snapshot does not revert a newer grade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
  const store = openStore(join(dir, 'school-pulse.sqlite'));
  ingestFile(store, new URL('../fixtures/powerschool/math-q2-2026-11-02.html', import.meta.url).pathname);
  ingestFile(store, new URL('../fixtures/powerschool/math-q1-2026-09-15.html', import.meta.url).pathname);
  const state = store.state(new Date('2026-11-02T17:11:00Z'));
  const math = state.students[0]?.courses.find((course) => course.name === 'Math');
  assert.equal(math?.percent, 84);
  store.close();
});

test('alerts stay off until a rule is enabled, then a drop can webhook', async () => {
  const store = openStore(':memory:');
  assert.equal(store.listAlertRules().length, 0);
  assert.equal((await evaluateAlerts(store, [])).length, 0);
  const hits: unknown[] = [];
  const hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = hook.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    store.saveAlertRules([{ id: 'drop', kind: 'grade_drop', threshold: 5, enabled: 1, webhook: `http://127.0.0.1:${port}/hook`, student_id: null }]);
    const dir = mkdtempSync(join(tmpdir(), 'pulse-alert-'));
    const inbox = join(dir, 'inbox');
    seedDemoInbox(inbox);
    const reports = ingestInbox(store, inbox);
    const changes = reports.flatMap((report) => report.changes);
    const fired = await evaluateAlerts(store, changes);
    assert.ok(fired.some((event) => event.summary === 'Math went from 91 to 84'));
    assert.equal(hits.length >= 1, true);
  } finally {
    hook.closeAllConnections();
    await new Promise<void>((resolve) => hook.close(() => resolve()));
    store.close();
  }
});

test('localhost ingest API is idempotent and broadcasts state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-http-'));
  const store = openStore(join(dir, 'school-pulse.sqlite'));
  const running = await startServer({ store, inbox: join(dir, 'inbox'), port: 0 });
  try {
    const health = await fetch(`${running.url}/api/health`);
    assert.equal(health.status, 200);
    const body = fixture('fixtures/generic/advisory.json');
    const first = await fetch(`${running.url}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(first.status, 200);
    const created = await first.json() as { unchanged: boolean; changes: { summary: string }[] };
    assert.equal(created.unchanged, false);
    assert.ok(created.changes.some((change) => change.summary.includes('Conference form')));
    const second = await fetch(`${running.url}/api/ingest`, { method: 'POST', body });
    const again = await second.json() as { unchanged: boolean };
    assert.equal(again.unchanged, true);
    const state = await fetch(`${running.url}/api/state`).then((response) => response.json()) as { students: { name: string }[] };
    assert.ok(state.students.some((student) => student.name === 'Student A'));
  } finally {
    await running.close();
    store.close();
  }
});
