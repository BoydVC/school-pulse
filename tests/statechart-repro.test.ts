import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInstalledAppFlow } from "../src/auth/oauth.js";
import { startWatcher } from "../src/ingest/watch.js";
import { main } from "../src/main.js";
import { listAssignments, listChanges, openDatabase } from "../src/store/db.js";
import { repoRoot } from "../src/util/root.js";
import { attachLiveStream } from "../web/live.js";

test("sync does not send an access token whose expires_at is in the past", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-expired-"));
  mkdirSync(join(dir, "tokens"), { recursive: true });
  writeFileSync(
    join(dir, "tokens", "google-classroom.json"),
    JSON.stringify({
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh",
      expires_at: "2020-01-01T00:00:00.000Z",
    }),
  );
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push(headers.get("authorization") ?? "");
    return Response.json({ courses: [] });
  }) as typeof fetch;
  delete process.env.SCHOOL_PULSE_CLASSROOM_TOKEN;
  delete process.env.SCHOOL_PULSE_GRAPH_TOKEN;
  try {
    await main(["sync", "--data", dir]);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 0);
});

test("an earlier sign-in does not overwrite a token written by a later sign-in", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sp-clobber-"));
  const tokenPath = join(directory, "tokens", "google-classroom.json");
  let releaseA = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let aFetching = false;
  const start = (label: string, fetchImpl: typeof fetch) =>
    runInstalledAppFlow({
      kind: "classroom",
      clientId: "desktop-client",
      tokenPath,
      tokenUrl: "http://127.0.0.1:9/unused",
      timeoutMs: 5000,
      fetchImpl,
      onAuthorizeUrl: (url) => {
        const parsed = new URL(url);
        const redirect = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        if (!redirect || !state) throw new Error("missing redirect");
        void fetch(`${redirect}?code=code-${label}&state=${state}`);
      },
    });
  const fetchA: typeof fetch = async () => {
    aFetching = true;
    await gate;
    return Response.json({
      access_token: "access-a",
      refresh_token: "refresh-a",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  const fetchB: typeof fetch = async () =>
    Response.json({
      access_token: "access-b",
      refresh_token: "refresh-b",
      expires_in: 3600,
      token_type: "Bearer",
    });
  const pendingA = start("a", fetchA);
  const deadline = Date.now() + 3000;
  while (!aFetching && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(aFetching, true);
  const pendingB = start("b", fetchB);
  await pendingB;
  releaseA();
  await pendingA;
  const stored = JSON.parse(readFileSync(tokenPath, "utf8")) as { refresh_token: string };
  assert.equal(stored.refresh_token, "refresh-b");
});

class FakeSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { fn, ms });
        return id;
      },
      clear: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const timer of due) timer.fn();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a silent event stream schedules a reconnect", async () => {
  const sockets: FakeSource[] = [];
  const clock = fakeTimers();
  let pill = "off";
  const open = (): void => {
    const socket = new FakeSource();
    sockets.push(socket);
    attachLiveStream(socket, { refresh: () => undefined, setConnected: (on) => { pill = on ? "on" : "off"; }, reconnect: open }, clock.timers);
  };
  open();
  sockets[0]?.onopen?.();
  await settle();
  assert.equal(pill, "on");
  assert.ok([...clock.pending.values()].some((timer) => timer.ms > 0 && timer.ms < 60_000));
  sockets[0]?.listeners.get("ping")?.();
  assert.equal(clock.pending.size, 1, "a ping re-arms one silence timer");
  clock.fire();
  assert.equal(pill, "off");
  assert.equal(sockets[0]?.closed, true);
  assert.equal(sockets.length, 2);
});

test("opening the stream refreshes before the pill is treated as caught up", async () => {
  const socket = new FakeSource();
  const clock = fakeTimers();
  let refreshes = 0;
  let release = (): void => {};
  let pill = "off";
  attachLiveStream(socket, {
    refresh: () => {
      refreshes += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    setConnected: (on) => { pill = on ? "on" : "off"; },
  }, clock.timers);
  socket.onopen?.();
  await settle();
  assert.equal(refreshes, 1);
  assert.equal(pill, "off", "pill stays off until the catch-up refresh resolves");
  release();
  await settle();
  assert.equal(pill, "on");
});

test("the event stream sends a ping event the browser can see", () => {
  const src = readFileSync(join(repoRoot(), "src/server/server.ts"), "utf8");
  assert.ok(src.includes('"event: ping\\n'));
});

function snapshot(sourceId: string): string {
  return JSON.stringify({
    students: [{ sourceId: "stu-a", name: "Student A" }],
    courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
    assignments: [{ sourceId, studentSourceId: "stu-a", courseSourceId: "math", title: "Problem set", status: "assigned" }],
  });
}

test("a watcher retry keeps one row when the source id is stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-stable-"));
  const db = openDatabase(join(dir, "school-pulse.sqlite"));
  let threw = false;
  const watcher = startWatcher({
    dataDir: dir,
    db,
    onResult() {
      if (!threw) {
        threw = true;
        throw new Error("callback failed once");
      }
    },
  });
  try {
    writeFileSync(join(dir, "inbox", "generic", "stable.json"), snapshot("quiz-1"));
    const deadline = Date.now() + 4000;
    while (listAssignments(db).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(listAssignments(db).length, 1);
  } finally {
    watcher.close();
  }
});

test("a watcher retry of {{SP:NOW}} does not insert a second row or a second change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-now-"));
  const db = openDatabase(join(dir, "school-pulse.sqlite"));
  let threw = false;
  const watcher = startWatcher({
    dataDir: dir,
    db,
    onResult() {
      if (!threw) {
        threw = true;
        throw new Error("callback failed once");
      }
    },
  });
  try {
    writeFileSync(join(dir, "inbox", "generic", "clock.json"), snapshot("{{SP:NOW}}"));
    const deadline = Date.now() + 4000;
    while (listChanges(db).length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = listAssignments(db).length;
    const changes = listChanges(db).length;
    assert.deepEqual({ rows, changes }, { rows: 1, changes: 1 });
  } finally {
    watcher.close();
  }
});
