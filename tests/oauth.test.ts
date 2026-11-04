import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLASSROOM_SCOPES, ONENOTE_SCOPES, buildAuthorizeUrl, runInstalledAppFlow } from "../src/auth/oauth.js";

test("authorize URLs are loopback installed-app requests with read-only scopes", () => {
  const classroom = new URL(buildAuthorizeUrl({
    kind: "classroom",
    clientId: "desktop-client",
    redirectUri: "http://127.0.0.1:9/callback",
    state: "state-1",
    codeChallenge: "challenge",
  }));
  assert.equal(classroom.origin, "https://accounts.google.com");
  assert.equal(classroom.searchParams.get("response_type"), "code");
  assert.equal(classroom.searchParams.get("code_challenge_method"), "S256");
  assert.equal(classroom.searchParams.get("redirect_uri"), "http://127.0.0.1:9/callback");
  assert.equal(classroom.searchParams.get("access_type"), "offline");
  assert.equal(classroom.searchParams.get("prompt"), "consent");
  assert.match(classroom.searchParams.get("scope") ?? "", /\bopenid\b/);
  assert.match(classroom.searchParams.get("scope") ?? "", /\bemail\b/);
  for (const scope of CLASSROOM_SCOPES) assert.match(classroom.searchParams.get("scope") ?? "", new RegExp(scope.replace(/[.]/g, "\\.")));
  assert.equal((classroom.searchParams.get("scope") ?? "").includes("classroom.coursework.students"), false);

  const graph = new URL(buildAuthorizeUrl({
    kind: "onenote",
    clientId: "graph-client",
    redirectUri: "http://127.0.0.1:9/callback",
    state: "state-2",
    codeChallenge: "challenge",
  }));
  assert.match(graph.origin, /login\.microsoftonline\.com$/);
  for (const scope of ONENOTE_SCOPES) assert.match(graph.searchParams.get("scope") ?? "", new RegExp(scope.replace(/[.]/g, "\\.")));
  assert.match(graph.searchParams.get("scope") ?? "", /offline_access/);
  assert.equal((graph.searchParams.get("scope") ?? "").includes("Mail."), false);
  assert.equal((graph.searchParams.get("scope") ?? "").includes("Notes.ReadWrite"), false);
  assert.equal(graph.searchParams.get("access_type"), null);
});

test("the loopback flow stores a token and never echoes it in the browser page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "school-pulse-auth-"));
  const tokenPath = join(directory, "tokens", "google-classroom.json");
  const tokenServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      assert.match(body, /code_verifier=/);
      assert.equal(body.includes("client_secret"), false);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "synthetic-access-token", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer", scope: CLASSROOM_SCOPES.join(" ") }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
  const address = tokenServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let seen = "";
  const result = await runInstalledAppFlow({
    kind: "classroom",
    clientId: "desktop-client",
    tokenPath,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    timeoutMs: 5000,
    fetchImpl: fetch,
    onAuthorizeUrl: (url) => {
      seen = url;
      const redirect = new URL(url).searchParams.get("redirect_uri");
      if (!redirect) throw new Error("missing redirect");
      void fetch(`${redirect}?code=synthetic-code&state=${new URL(url).searchParams.get("state")}`);
    },
  });
  tokenServer.close();
  const parsed = new URL(seen);
  assert.equal(parsed.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:"), true);
  const stored = JSON.parse(readFileSync(result.path, "utf8")) as { access_token: string; refresh_token: string };
  assert.equal(stored.access_token, "synthetic-access-token");
  assert.equal(stored.refresh_token, "synthetic-refresh");
  assert.equal(result.token.refresh_token, "synthetic-refresh");
  assert.equal(result.authorizeUrl.includes("synthetic-access-token"), false);
});
