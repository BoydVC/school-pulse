import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname } from "node:path";

export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
] as const;

export const ONENOTE_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Notes.Read",
] as const;

const CLASSROOM_IDENTITY_SCOPES = ["openid", "email"] as const;

export type AuthKind = "classroom" | "onenote";

export interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  expires_at: string | null;
  /** Present on the auth-code response when the provider sends one. Not written to disk. */
  id_token?: string | null;
}

export class ReauthRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`re-auth needed (${reason})`);
    this.name = "ReauthRequiredError";
    this.reason = reason;
  }
}

export interface AuthFlowOptions {
  kind: AuthKind;
  clientId: string;
  clientSecret?: string | null;
  tokenPath?: string;
  tenant?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onAuthorizeUrl?: (url: string) => void;
  /** When true, the caller stores the token (one file can hold several accounts). */
  skipWrite?: boolean;
}

export function scopesFor(kind: AuthKind): readonly string[] {
  return kind === "classroom" ? [...CLASSROOM_IDENTITY_SCOPES, ...CLASSROOM_SCOPES] : ONENOTE_SCOPES;
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
  const payload = (await response.json()) as TokenPayload;
  return tokenFromPayload(payload, response.ok, response.status, input.kind, null, "Token endpoint refused the code");
}

export async function refreshAccessToken(input: {
  kind: AuthKind;
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  scope?: string;
  tokenUrl?: string;
  tenant?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  if (input.kind === "onenote") body.set("scope", input.scope || scopesFor("onenote").join(" "));
  const response = await (input.fetchImpl ?? fetch)(input.tokenUrl ?? defaultTokenUrl(input.kind, input.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new Error(`token endpoint returned HTTP ${response.status}`);
  }
  let payload: TokenPayload = {};
  try {
    payload = (await response.json()) as TokenPayload;
  } catch {
    if (response.status === 401) throw new ReauthRequiredError(`token endpoint returned HTTP ${response.status}`);
    throw new Error(`token endpoint returned HTTP ${response.status}`);
  }
  if (response.status === 401 || payload.error === "invalid_grant") {
    const detail = typeof payload.error_description === "string" ? payload.error_description : typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new ReauthRequiredError(cleanReason(detail));
  }
  return tokenFromPayload(payload, response.ok, response.status, input.kind, input.refreshToken, "Token endpoint refused the refresh", input.now);
}

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function tokenFromPayload(
  payload: TokenPayload,
  ok: boolean,
  status: number,
  kind: AuthKind,
  previousRefresh: string | null,
  failurePrefix: string,
  now = new Date(),
): StoredToken {
  if (!ok || typeof payload.access_token !== "string") {
    const detail = typeof payload.error_description === "string" ? payload.error_description : typeof payload.error === "string" ? payload.error : `HTTP ${status}`;
    throw new Error(`${failurePrefix} (${cleanReason(detail)})`);
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : previousRefresh;
  const token: StoredToken = {
    access_token: payload.access_token,
    refresh_token: refresh,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : scopesFor(kind).join(" "),
    expires_at: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000).toISOString(),
  };
  if (typeof payload.id_token === "string") token.id_token = payload.id_token;
  return token;
}

function cleanReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function writeToken(path: string, token: StoredToken): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

function generationPath(tokenPath: string): string {
  return `${tokenPath}.generation`;
}

function claimTokenGeneration(tokenPath: string, generation: string): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(generationPath(tokenPath), `${generation}\n`, { mode: 0o600 });
}

function ownsTokenGeneration(tokenPath: string, generation: string): boolean {
  try {
    return readFileSync(generationPath(tokenPath), "utf8").trim() === generation;
  } catch {
    return true;
  }
}

/**
 * Installed-app loopback: bind 127.0.0.1, print the authorize URL, exchange the
 * code, and store the token under the data directory. Read-only scopes only.
 */
export async function runInstalledAppFlow(options: AuthFlowOptions): Promise<{ path: string; authorizeUrl: string; token: StoredToken }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const challenge = codeChallenge(verifier);
  const timeoutMs = options.timeoutMs ?? 180_000;
  // Stamp this sign-in as the newest one for the token file. A flow that started
  // earlier and finishes later must not overwrite the token a newer flow wrote.
  const generation = `${Date.now()}-${state}`;
  if (!options.skipWrite && options.tokenPath) claimTokenGeneration(options.tokenPath, generation);

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
  const path = options.tokenPath ?? "";
  if (!options.skipWrite) {
    if (!path) throw new Error("tokenPath is required to store a token");
    if (!ownsTokenGeneration(path, generation)) {
      console.error("School Pulse: a newer sign-in started after this one, so this sign-in did not overwrite its token.");
    } else writeToken(path, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      scope: token.scope,
      expires_at: token.expires_at,
    });
  }
  return {
    path,
    token,
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
