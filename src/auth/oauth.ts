import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname } from "node:path";

export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
] as const;

export const ONENOTE_SCOPES = ["offline_access", "https://graph.microsoft.com/Notes.Read"] as const;

export type AuthKind = "classroom" | "onenote";

export interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  expires_at: string | null;
}

export interface AuthFlowOptions {
  kind: AuthKind;
  clientId: string;
  clientSecret?: string | null;
  tokenPath: string;
  tenant?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onAuthorizeUrl?: (url: string) => void;
}

export function scopesFor(kind: AuthKind): readonly string[] {
  return kind === "classroom" ? CLASSROOM_SCOPES : ONENOTE_SCOPES;
}

export function defaultAuthorizeUrl(kind: AuthKind, tenant = "common"): string {
  if (kind === "classroom") return "https://accounts.google.com/o/oauth2/v2/auth";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function defaultTokenUrl(kind: AuthKind, tenant = "common"): string {
  if (kind === "classroom") return "https://oauth2.googleapis.com/token";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function buildAuthorizeUrl(input: {
  kind: AuthKind;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  authorizeUrl?: string;
  tenant?: string;
}): string {
  const url = new URL(input.authorizeUrl ?? defaultAuthorizeUrl(input.kind, input.tenant));
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopesFor(input.kind).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.kind === "classroom") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function exchangeAuthCode(input: {
  kind: AuthKind;
  clientId: string;
  clientSecret?: string | null;
  code: string;
  redirectUri: string;
  verifier: string;
  tokenUrl?: string;
  tenant?: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const response = await (input.fetchImpl ?? fetch)(input.tokenUrl ?? defaultTokenUrl(input.kind, input.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; scope?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  if (!response.ok || typeof payload.access_token !== "string") {
    const detail = typeof payload.error_description === "string" ? payload.error_description : typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Token endpoint refused the code (${detail})`);
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : scopesFor(input.kind).join(" "),
    expires_at: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export function writeToken(path: string, token: StoredToken): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Installed-app loopback: bind 127.0.0.1, print the authorize URL, exchange the
 * code, and store the token under the data directory. Read-only scopes only.
 */
export async function runInstalledAppFlow(options: AuthFlowOptions): Promise<{ path: string; authorizeUrl: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const challenge = codeChallenge(verifier);
  const timeoutMs = options.timeoutMs ?? 180_000;

  const code = await new Promise<{ value: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== "/callback") {
        respond(res, 404, "Not found");
        return;
      }
      const receivedState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        respond(res, 400, "School Pulse did not receive a token. You can close this window.");
        finish(reject, new Error(`Authorization server returned ${oauthError}`));
        return;
      }
      if (!authCode || receivedState !== state) {
        respond(res, 400, "School Pulse could not match this sign-in. You can close this window.");
        finish(reject, new Error("Loopback redirect was missing a matching code"));
        return;
      }
      respond(res, 200, "School Pulse stored the read-only token in the local data directory. You can close this window.");
      finish(resolve, { value: authCode, redirectUri: `http://127.0.0.1:${port}/callback` });
    });
    let port = 0;
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the loopback redirect"));
    }, timeoutMs);
    const finish = (settle: (value: never) => void, value: unknown): void => {
      clearTimeout(timer);
      server.close();
      settle(value as never);
    };
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authorizeUrl = buildAuthorizeUrl({
        kind: options.kind,
        clientId: options.clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
        authorizeUrl: options.authorizeUrl,
        tenant: options.tenant,
      });
      options.onAuthorizeUrl?.(authorizeUrl);
    });
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const token = await exchangeAuthCode({
    kind: options.kind,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    code: code.value,
    redirectUri: code.redirectUri,
    verifier,
    tokenUrl: options.tokenUrl,
    tenant: options.tenant,
    fetchImpl: options.fetchImpl,
  });
  writeToken(options.tokenPath, token);
  return {
    path: options.tokenPath,
    authorizeUrl: buildAuthorizeUrl({
      kind: options.kind,
      clientId: options.clientId,
      redirectUri: code.redirectUri,
      state,
      codeChallenge: challenge,
      authorizeUrl: options.authorizeUrl,
      tenant: options.tenant,
    }),
  };
}

function respond(res: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><title>School Pulse</title><p>${message}</p>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}
