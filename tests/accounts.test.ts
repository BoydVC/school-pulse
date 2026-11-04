import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureFreshAccount,
  formatAuthStatus,
  identifyAccount,
  listAccounts,
  reauthNotices,
  signInAccount,
  tokenFilePath,
  upsertAccount,
  writeAccountStore,
  type AccountToken,
} from "../src/auth/accounts.js";
import { refreshAccessToken, writeToken } from "../src/auth/oauth.js";
import { syncAccounts } from "../src/auth/sync.js";
import { buildDashboard } from "../src/dashboard/build.js";
import { seedDemo } from "../src/demo/seed.js";
import { authorizedGet, createSession } from "../src/faithful/fetch/session.js";
import { fetchClassroomSnapshot } from "../src/faithful/fetch/classroom.js";
import { fetchOneNoteSnapshot } from "../src/faithful/fetch/onenote.js";
import { reauthBadgeText } from "../src/model/freshness.js";
import { startServer } from "../src/server/server.js";
import { listAssignments, openDatabase } from "../src/store/db.js";
import { repoRoot } from "../src/util/root.js";
import { fixedNow } from "./helpers.js";

const NOW = new Date("2026-11-02T18:00:00.000Z");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function account(partial: Partial<AccountToken> & Pick<AccountToken, "accountKey" | "studentId" | "access_token">): AccountToken {
  return {
    email: partial.email ?? null,
    accountId: partial.accountId ?? null,
    refresh_token: partial.refresh_token === undefined ? "synthetic-refresh" : partial.refresh_token,
    token_type: "Bearer",
    scope: "openid email",
    expires_at: partial.expires_at === undefined ? new Date(NOW.getTime() + 3_600_000).toISOString() : partial.expires_at,
    reauth_needed: partial.reauth_needed ?? false,
    reauth_reason: partial.reauth_reason ?? null,
    updated_at: NOW.toISOString(),
    accountKey: partial.accountKey,
    studentId: partial.studentId,
    access_token: partial.access_token,
  };
}

test("a second student is stored beside the first, including a legacy single-token file", () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-accounts-"));
  const path = tokenFilePath(directory, "classroom");
  writeToken(path, {
    access_token: "legacy-access",
    refresh_token: "legacy-refresh",
    token_type: "Bearer",
    scope: "openid",
    expires_at: null,
  });
  upsertAccount(path, account({
    accountKey: "student.b@example.com",
    email: "student.b@example.com",
    accountId: "10002",
    studentId: "stu-b",
    access_token: "second-access",
    refresh_token: "second-refresh",
  }));
  const stored = listAccounts(path);
  assert.equal(stored.length, 2);
  assert.equal(stored.find((item) => item.accountKey === "legacy")?.access_token, "legacy-access");
  assert.equal(stored.find((item) => item.accountKey === "legacy")?.refresh_token, "legacy-refresh");
  assert.equal(stored.find((item) => item.studentId === "stu-b")?.access_token, "second-access");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes("\"version\": 2"), true);
  assert.equal(raw.includes("legacy-access"), true);
  assert.equal(raw.includes("second-access"), true);
});

test("account keys prefer the signed-in email and fall back to the id", async () => {
  const fromEmail = await identifyAccount({
    kind: "classroom",
    accessToken: "opaque-access",
    idToken: jwt({ exp: 1_700_000_000, email: "Student.A@Example.com", sub: "10001" }),
    fetchImpl: async () => {
      throw new Error("profile should not be called when the id token has an email");
    },
  });
  assert.equal(fromEmail.accountKey, "student.a@example.com");
  assert.equal(fromEmail.email, "student.a@example.com");
  assert.equal(fromEmail.accountId, "10001");

  const fromId = await identifyAccount({
    kind: "onenote",
    accessToken: jwt({ iss: "https://login.microsoftonline.com/common/v2.0", oid: "oid-9" }),
  });
  assert.equal(fromId.accountKey, "id:oid-9");
  assert.equal(fromId.email, null);

  const fromProfile = await identifyAccount({
    kind: "classroom",
    accessToken: "opaque-access",
    fetchImpl: async (input, init) => {
      assert.match(String(input), /userProfiles\/me$/);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer opaque-access");
      return jsonResponse(200, { id: "10003", emailAddress: "student.b@example.com", name: { fullName: "Student B" } });
    },
  });
  assert.deepEqual(fromProfile, { accountKey: "student.b@example.com", email: "student.b@example.com", accountId: "10003" });

  const fromGraph = await identifyAccount({
    kind: "onenote",
    accessToken: "opaque-graph",
    fetchImpl: async (input) => {
      assert.match(String(input), /graph\.microsoft\.com/);
      return jsonResponse(200, { id: "oid-4", mail: null, userPrincipalName: "student.a@example.com" });
    },
  });
  assert.equal(fromGraph.accountKey, "student.a@example.com");
  assert.equal(fromGraph.accountId, "oid-4");
});

test("refresh runs before expiry, keeps the old refresh token, and asks again on 401", async () => {
  let body = "";
  const soon = await ensureFreshAccount({
    account: account({
      accountKey: "student.a@example.com",
      email: "student.a@example.com",
      studentId: "stu-a",
      access_token: "access-old",
      refresh_token: "synthetic-refresh",
      expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
    }),
    kind: "classroom",
    clientId: "desktop-client",
    now: NOW,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://oauth2.googleapis.com/token");
      assert.equal(String(input).includes("refresh_token="), false);
      body = String(init?.body ?? "");
      return jsonResponse(200, { access_token: "access-new", expires_in: 3600, token_type: "Bearer" });
    },
  });
  assert.equal(soon.access_token, "access-new");
  assert.equal(soon.refresh_token, "synthetic-refresh");
  assert.equal(soon.reauth_needed, false);
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "synthetic-refresh");
  assert.equal(params.get("client_id"), "desktop-client");
  assert.equal(params.get("scope"), null);

  let graphBody = "";
  await refreshAccessToken({
    kind: "onenote",
    clientId: "graph-client",
    refreshToken: "synthetic-refresh",
    scope: "offline_access https://graph.microsoft.com/Notes.Read",
    now: NOW,
    fetchImpl: async (input, init) => {
      assert.match(String(input), /\/oauth2\/v2\.0\/token$/);
      graphBody = String(init?.body ?? "");
      return jsonResponse(200, { access_token: "graph-new", expires_in: 3600, token_type: "Bearer", refresh_token: "rotated-refresh" });
    },
  }).then((token) => {
    assert.equal(token.access_token, "graph-new");
    assert.equal(token.refresh_token, "rotated-refresh");
  });
  const graphParams = new URLSearchParams(graphBody);
  assert.equal(graphParams.get("grant_type"), "refresh_token");
  assert.match(graphParams.get("scope") ?? "", /offline_access/);

  let called = 0;
  const fresh = await ensureFreshAccount({
    account: account({
      accountKey: "student.a@example.com",
      studentId: "stu-a",
      access_token: "access-ok",
      expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    }),
    kind: "classroom",
    clientId: "desktop-client",
    now: NOW,
    fetchImpl: async () => {
      called += 1;
      return jsonResponse(500, {});
    },
  });
  assert.equal(called, 0);
  assert.equal(fresh.access_token, "access-ok");

  const revoked = await ensureFreshAccount({
    account: account({
      accountKey: "student.a@example.com",
      studentId: "stu-a",
      access_token: "access-old",
      refresh_token: "synthetic-refresh",
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
    }),
    kind: "classroom",
    clientId: "desktop-client",
    now: NOW,
    fetchImpl: async () => jsonResponse(400, { error: "invalid_grant", error_description: "revoked" }),
  });
  assert.equal(revoked.reauth_needed, true);
  assert.match(revoked.reauth_reason ?? "", /revoked/);
  assert.equal(revoked.refresh_token, "synthetic-refresh");
  assert.equal(revoked.access_token, "access-old");

  const missingClient = await ensureFreshAccount({
    account: account({
      accountKey: "id:10001",
      studentId: "stu-a",
      access_token: "access-old",
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
    }),
    kind: "classroom",
    clientId: null,
    now: NOW,
    fetchImpl: async () => {
      throw new Error("refresh should not be attempted without a client id");
    },
  });
  assert.match(missingClient.reauth_reason ?? "", /SCHOOL_PULSE_GOOGLE_CLIENT_ID/);

  const noRefresh = await ensureFreshAccount({
    account: account({
      accountKey: "id:10001",
      studentId: "stu-a",
      access_token: "access-old",
      refresh_token: null,
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
    }),
    kind: "onenote",
    clientId: "graph-client",
    now: NOW,
  });
  assert.match(noRefresh.reauth_reason ?? "", /no refresh token/);

  let skipped = 0;
  const held = await ensureFreshAccount({
    account: revoked,
    kind: "classroom",
    clientId: "desktop-client",
    now: NOW,
    fetchImpl: async () => {
      skipped += 1;
      return jsonResponse(200, { access_token: "should-not-issue", expires_in: 10 });
    },
  });
  assert.equal(skipped, 0);
  assert.equal(held.reauth_needed, true);
});

test("status output names the student and never prints token secrets", () => {
  const text = formatAuthStatus({
    classroom: [
      account({
        accountKey: "student.a@example.com",
        email: "student.a@example.com",
        studentId: "stu-a",
        access_token: "synthetic-access-SECRET",
        refresh_token: "synthetic-refresh-SECRET",
        reauth_needed: true,
        reauth_reason: "revoked",
      }),
    ],
    onenote: [],
  });
  assert.match(text, /classroom {2}student\.a@example\.com {2}student stu-a {2}re-auth needed \(revoked\)/);
  assert.match(text, /onenote {2}no accounts/);
  assert.equal(text.includes("synthetic-access-SECRET"), false);
  assert.equal(text.includes("synthetic-refresh-SECRET"), false);
  assert.equal(reauthBadgeText("google-classroom", ["stu-a"]), "Classroom · stu-a · re-auth needed");
  assert.equal(reauthBadgeText("onenote", ["legacy"]), "OneNote · re-auth needed");
});

test("Classroom and OneNote retry a 401 once and then stop", async () => {
  let classroomRefreshes = 0;
  await fetchClassroomSnapshot({
    token: "stale",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer stale") return jsonResponse(401, {});
      if (url.includes("/courses?")) return jsonResponse(200, { courses: [] });
      if (url.includes("/userProfiles/me")) return jsonResponse(200, { id: "ga", name: { fullName: "Student A" } });
      return jsonResponse(404, {});
    },
    onUnauthorized: async () => {
      classroomRefreshes += 1;
      return "fresh";
    },
  });
  assert.equal(classroomRefreshes, 1);

  let graphRefreshes = 0;
  const page = "<html><head><meta name=\"school-pulse-student\" content=\"Student A\"></head><body><p data-tag=\"to-do\">Map skills — due Nov 6, 2026</p></body></html>";
  const snapshot = await fetchOneNoteSnapshot({
    token: "stale-graph",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer stale-graph") return jsonResponse(401, {});
      if (url.includes("/notebooks")) {
        return jsonResponse(200, { value: [{ id: "nb", displayName: "History", sections: [{ id: "sec", displayName: "Homework" }], sectionGroups: [] }] });
      }
      if (url.includes("/content")) return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      if (url.includes("/pages")) {
        return jsonResponse(200, {
          value: [{
            id: "p1",
            title: "Homework",
            createdDateTime: "2026-11-02T15:00:00.000Z",
            contentUrl: "https://graph.microsoft.com/v1.0/me/onenote/pages/p1/content",
            parentNotebook: { id: "nb", displayName: "History" },
          }],
        });
      }
      return jsonResponse(404, {});
    },
    onUnauthorized: async () => {
      graphRefreshes += 1;
      return "fresh-graph";
    },
  });
  assert.equal(graphRefreshes, 1);
  assert.equal(Array.isArray((snapshot as { value?: unknown }).value), true);

  let repeated = 0;
  await assert.rejects(
    () => fetchClassroomSnapshot({
      token: "stale",
      fetchImpl: async () => jsonResponse(401, {}),
      onUnauthorized: async () => {
        repeated += 1;
        return "still-stale";
      },
    }),
    /401/,
  );
  assert.equal(repeated, 1);

  await assert.rejects(
    () => authorizedGet(createSession({ token: "t", fetchImpl: async () => jsonResponse(200, {}) }), "http://127.0.0.1/courses", "application/json", "Classroom"),
    /https/,
  );
});

test("sync walks every Classroom and OneNote account and flags a failed refresh", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-sync-"));
  const classroomPath = tokenFilePath(directory, "classroom");
  const onenotePath = tokenFilePath(directory, "onenote");
  writeAccountStore(classroomPath, {
    version: 2,
    accounts: {
      "student.a@example.com": account({
        accountKey: "student.a@example.com",
        email: "student.a@example.com",
        accountId: "10001",
        studentId: "stu-a",
        access_token: "access-a",
        refresh_token: "refresh-a",
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
      }),
      "student.b@example.com": account({
        accountKey: "student.b@example.com",
        email: "student.b@example.com",
        accountId: "10002",
        studentId: "stu-b",
        access_token: "access-b",
        refresh_token: "refresh-b",
        expires_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      }),
      "student.c@example.com": account({
        accountKey: "student.c@example.com",
        email: "student.c@example.com",
        accountId: "10003",
        studentId: "stu-c",
        access_token: "access-c",
        refresh_token: "refresh-c",
        expires_at: new Date(NOW.getTime() - 5_000).toISOString(),
      }),
    },
  });
  writeAccountStore(onenotePath, {
    version: 2,
    accounts: {
      "student.a@example.com": account({
        accountKey: "student.a@example.com",
        email: "student.a@example.com",
        accountId: "oid-a",
        studentId: "stu-a",
        access_token: "access-note",
        refresh_token: "refresh-note",
        expires_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      }),
    },
  });

  const refreshes: string[] = [];
  const bearers = new Set<string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth) bearers.add(auth);
    if (url.includes("/token")) {
      assert.equal(url.includes("refresh_token="), false);
      const refresh = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
      refreshes.push(refresh);
      if (refresh === "refresh-c") return jsonResponse(400, { error: "invalid_grant", error_description: "revoked" });
      if (refresh === "refresh-a") return jsonResponse(200, { access_token: "access-a2", expires_in: 3600, token_type: "Bearer" });
      if (refresh === "refresh-b") return jsonResponse(200, { access_token: "access-b2", expires_in: 3600, token_type: "Bearer", refresh_token: "refresh-b2" });
      return jsonResponse(400, { error: "invalid_grant", error_description: "unexpected refresh" });
    }
    if (url.includes("classroom.googleapis.com")) return classroomResponse(url, auth);
    if (url.includes("graph.microsoft.com")) return graphResponse(url, auth);
    return jsonResponse(404, { url });
  };

  const db = openDatabase(join(directory, "school-pulse.sqlite"));
  const result = await syncAccounts({
    dataDir: directory,
    db,
    now: NOW,
    fetchImpl,
    env: {
      SCHOOL_PULSE_GOOGLE_CLIENT_ID: "desktop-client",
      SCHOOL_PULSE_GRAPH_CLIENT_ID: "graph-client",
      SCHOOL_PULSE_CLASSROOM_TOKEN: "env-should-not-be-used",
    },
  });

  assert.deepEqual(refreshes, ["refresh-a", "refresh-b", "refresh-c"]);
  assert.equal(bearers.has("Bearer access-a2"), true);
  assert.equal(bearers.has("Bearer access-b"), true);
  assert.equal(bearers.has("Bearer access-b2"), true);
  assert.equal(bearers.has("Bearer access-c"), false);
  assert.equal(bearers.has("Bearer access-note"), true);
  assert.equal(bearers.has("Bearer env-should-not-be-used"), false);
  assert.equal(result.wrote, true);
  assert.match(result.messages.join("\n"), /Classroom stu-c: re-auth needed \(revoked\)/);
  const titles = listAssignments(db).map((item) => item.title).sort();
  assert.equal(titles.includes("Reading log A"), true);
  assert.equal(titles.includes("Reading log B"), true);
  assert.equal(titles.includes("Map skills"), true);

  const classroom = listAccounts(classroomPath);
  assert.equal(classroom.find((item) => item.studentId === "stu-a")?.access_token, "access-a2");
  assert.equal(classroom.find((item) => item.studentId === "stu-a")?.refresh_token, "refresh-a");
  assert.equal(classroom.find((item) => item.studentId === "stu-b")?.access_token, "access-b2");
  assert.equal(classroom.find((item) => item.studentId === "stu-b")?.refresh_token, "refresh-b2");
  const failed = classroom.find((item) => item.studentId === "stu-c");
  assert.equal(failed?.reauth_needed, true);
  assert.equal(failed?.refresh_token, "refresh-c");
  assert.equal(failed?.access_token, "access-c");

  const board = buildDashboard(db, NOW, { reauth: reauthNotices(directory) });
  const badge = board.sources.find((source) => source.state === "reauth");
  assert.equal(badge?.text, "Classroom · stu-c · re-auth needed");
});

test("an environment token is used only when the token file has no accounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-env-token-"));
  const seen: string[] = [];
  const db = openDatabase(join(directory, "school-pulse.sqlite"));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(new Headers(init?.headers).get("authorization") ?? url);
    if (url.includes("/userProfiles/me")) return jsonResponse(200, { id: "ga", name: { fullName: "Student A" } });
    if (url.includes("/courses?")) return jsonResponse(200, { courses: [] });
    return jsonResponse(404, {});
  };
  const result = await syncAccounts({
    dataDir: directory,
    db,
    now: NOW,
    fetchImpl,
    env: { SCHOOL_PULSE_CLASSROOM_TOKEN: "env-access" },
  });
  assert.equal(result.wrote, true);
  assert.equal(seen.includes("Bearer env-access"), true);
  upsertAccount(tokenFilePath(directory, "classroom"), account({
    accountKey: "student.a@example.com",
    email: "student.a@example.com",
    studentId: "stu-a",
    access_token: "file-access",
    expires_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
  }));
  seen.length = 0;
  await syncAccounts({
    dataDir: directory,
    db,
    now: NOW,
    fetchImpl,
    env: { SCHOOL_PULSE_CLASSROOM_TOKEN: "env-access" },
  });
  assert.equal(seen.includes("Bearer file-access"), true);
  assert.equal(seen.includes("Bearer env-access"), false);
});

test("the dashboard badge says re-auth needed", async () => {
  const now = fixedNow();
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-badge-"));
  upsertAccount(tokenFilePath(directory, "classroom"), account({
    accountKey: "student.a@example.com",
    email: "student.a@example.com",
    studentId: "stu-a",
    access_token: "synthetic-access",
    reauth_needed: true,
    reauth_reason: "revoked",
  }));
  const db = openDatabase(join(directory, "school-pulse.sqlite"));
  seedDemo(db, now);
  const server = await startServer({ db, host: "127.0.0.1", port: 0, dataDir: directory });
  try {
    const board = await fetch(`${server.url}/api/dashboard`).then((response) => response.json()) as {
      sources: Array<{ source: string; state: string; text: string }>;
    };
    const classroom = board.sources.find((source) => source.source === "google-classroom");
    assert.equal(classroom?.state, "reauth");
    assert.equal(classroom?.text, "Classroom · stu-a · re-auth needed");
    const onenote = board.sources.find((source) => source.source === "onenote");
    assert.equal(onenote?.state, "stale");
  } finally {
    await server.close();
  }
});

test("signing in a second student keeps the first account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-signin-"));
  const storePath = tokenFilePath(directory, "classroom");
  const graphPath = tokenFilePath(directory, "onenote");
  const issued: Record<string, { access: string; refresh: string; email: string; sub: string }> = {
    "code-a": { access: "access-a", refresh: "refresh-a", email: "student.a@example.com", sub: "10001" },
    "code-b": { access: "access-b", refresh: "refresh-b", email: "student.b@example.com", sub: "10002" },
    "code-a2": { access: "access-a2", refresh: "refresh-a2", email: "student.a@example.com", sub: "10001" },
    "code-note": { access: "access-note", refresh: "refresh-note", email: "student.a@example.com", sub: "oid-a" },
  };
  const tokenServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const code = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("code") ?? "";
      const row = issued[code];
      if (!row) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "unknown code" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: row.access,
        refresh_token: row.refresh,
        expires_in: 3600,
        token_type: "Bearer",
        id_token: jwt({ exp: 1_900_000_000, email: row.email, sub: row.sub }),
      }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
  const address = tokenServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sign = (kind: "classroom" | "onenote", studentId: string, code: string, path: string) => signInAccount({
    kind,
    clientId: "desktop-client",
    studentId,
    storePath: path,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    timeoutMs: 5000,
    fetchImpl: fetch,
    onAuthorizeUrl: (url) => {
      const parsed = new URL(url);
      if (kind === "classroom") {
        assert.equal(parsed.searchParams.get("access_type"), "offline");
        assert.equal(parsed.searchParams.get("prompt"), "consent");
      } else {
        assert.match(parsed.searchParams.get("scope") ?? "", /offline_access/);
      }
      const redirect = parsed.searchParams.get("redirect_uri");
      const state = parsed.searchParams.get("state");
      void fetch(`${redirect}?code=${code}&state=${state}`);
    },
  });
  try {
    await sign("classroom", "stu-a", "code-a", storePath);
    await sign("classroom", "stu-b", "code-b", storePath);
    let stored = listAccounts(storePath);
    assert.deepEqual(stored.map((item) => item.studentId), ["stu-a", "stu-b"]);
    assert.equal(stored.find((item) => item.studentId === "stu-a")?.access_token, "access-a");
    assert.equal(stored.find((item) => item.studentId === "stu-a")?.refresh_token, "refresh-a");
    assert.equal(stored.find((item) => item.studentId === "stu-b")?.access_token, "access-b");
    await sign("classroom", "stu-a", "code-a2", storePath);
    stored = listAccounts(storePath);
    assert.equal(stored.length, 2);
    assert.equal(stored.find((item) => item.studentId === "stu-a")?.access_token, "access-a2");
    assert.equal(stored.find((item) => item.studentId === "stu-b")?.refresh_token, "refresh-b");
    assert.equal(readFileSync(storePath, "utf8").includes("id_token"), false);
    await sign("onenote", "stu-a", "code-note", graphPath);
    assert.equal(listAccounts(graphPath)[0]?.refresh_token, "refresh-note");
    assert.equal(listAccounts(storePath).length, 2);
  } finally {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  }
});

test("auth status and auth --student are wired through the CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-auth-cli-"));
  const cli = join(repoRoot(), "dist", "src", "cli.js");
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cli, ...args, "--data", directory],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  const empty = run(["auth", "status"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /classroom {2}no accounts/);
  assert.match(empty.stdout, /onenote {2}no accounts/);

  const missing = run(["auth", "classroom"], { SCHOOL_PULSE_GOOGLE_CLIENT_ID: "desktop-client" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--student/);

  upsertAccount(tokenFilePath(directory, "onenote"), account({
    accountKey: "student.b@example.com",
    email: "student.b@example.com",
    studentId: "stu-b",
    access_token: "synthetic-access-SECRET",
    refresh_token: "synthetic-refresh-SECRET",
    reauth_needed: true,
    reauth_reason: "revoked",
  }));
  const status = run(["auth", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /onenote {2}student\.b@example\.com {2}student stu-b {2}re-auth needed \(revoked\)/);
  assert.equal(status.stdout.includes("synthetic-access-SECRET"), false);
  assert.equal(status.stdout.includes("synthetic-refresh-SECRET"), false);
});

function classroomResponse(url: string, auth: string | null): Response {
  if (auth === "Bearer access-b" && url.includes("/courses?")) return jsonResponse(401, { error: "unauthorized" });
  const student = auth === "Bearer access-a2"
    ? { id: "ga", name: "Student A", title: "Reading log A" }
    : auth === "Bearer access-b2"
      ? { id: "gb", name: "Student B", title: "Reading log B" }
      : null;
  if (!student) return jsonResponse(401, { error: "unauthorized" });
  if (url.includes("/courseWork?")) {
    return jsonResponse(200, {
      courseWork: [{ id: `work-${student.id}`, courseId: `course-${student.id}`, title: student.title, state: "PUBLISHED", maxPoints: 10 }],
    });
  }
  if (url.includes("/studentSubmissions")) return jsonResponse(200, { studentSubmissions: [] });
  if (url.includes("/userProfiles/me")) return jsonResponse(200, { id: student.id, name: { fullName: student.name } });
  if (url.includes("/courses?")) {
    return jsonResponse(200, { courses: [{ id: `course-${student.id}`, name: "English", courseState: "ACTIVE" }] });
  }
  return jsonResponse(404, {});
}

function graphResponse(url: string, auth: string | null): Response {
  if (auth !== "Bearer access-note") return jsonResponse(401, {});
  if (url.includes("/notebooks")) {
    return jsonResponse(200, { value: [{ id: "nb", displayName: "History", sections: [{ id: "sec", displayName: "Homework" }], sectionGroups: [] }] });
  }
  if (url.includes("/content")) {
    return new Response(
      "<html><head><meta name=\"school-pulse-student\" content=\"Student A\"><meta name=\"school-pulse-school\" content=\"Pinecrest Middle\"></head><body><p data-tag=\"to-do\">Map skills due 2026-11-06</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }
  if (url.includes("/pages")) {
    return jsonResponse(200, {
      value: [{
        id: "p1",
        title: "Homework",
        createdDateTime: "2026-11-02T15:00:00.000Z",
        contentUrl: "https://graph.microsoft.com/v1.0/me/onenote/pages/p1/content",
        parentNotebook: { id: "nb", displayName: "History" },
        parentSection: { id: "sec", displayName: "Homework" },
      }],
    });
  }
  return jsonResponse(404, {});
}
