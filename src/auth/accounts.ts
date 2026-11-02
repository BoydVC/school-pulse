import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  refreshAccessToken,
  ReauthRequiredError,
  runInstalledAppFlow,
  scopesFor,
  type AuthFlowOptions,
  type AuthKind,
  type StoredToken,
} from "./oauth.js";

export const REFRESH_SKEW_MS = 60_000;

export interface AccountIdentity {
  accountKey: string;
  email: string | null;
  accountId: string | null;
}

export interface AccountToken {
  accountKey: string;
  email: string | null;
  accountId: string | null;
  studentId: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  expires_at: string | null;
  reauth_needed: boolean;
  reauth_reason: string | null;
  updated_at: string;
}

export interface AccountStore {
  version: 2;
  accounts: Record<string, AccountToken>;
}

export interface ReauthNotice {
  source: string;
  studentId: string;
}

export function tokenFileName(kind: AuthKind): string {
  return kind === "classroom" ? "google-classroom.json" : "microsoft-graph.json";
}

export function tokenFilePath(dataDir: string, kind: AuthKind): string {
  return join(dataDir, "tokens", tokenFileName(kind));
}

export function sourceForKind(kind: AuthKind): "google-classroom" | "onenote" {
  return kind === "classroom" ? "google-classroom" : "onenote";
}

export function assertStudentId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (!id || id.length > 80 || /[\s/\\]/.test(id)) {
    throw new Error("Pass --student <id> (letters, numbers, and . _ -). Example: --student stu-a");
  }
  return id;
}

export function readJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function identityFromClaims(claims: Record<string, unknown>): AccountIdentity | null {
  const email = emailOf(claims.email) ?? emailOf(claims.preferred_username) ?? emailOf(claims.upn);
  const accountId = textOf(claims.sub) ?? textOf(claims.oid) ?? textOf(claims.id);
  if (!email && !accountId) return null;
  return {
    accountKey: email ?? `id:${accountId}`,
    email,
    accountId,
  };
}

export function defaultProfileUrl(kind: AuthKind): string {
  if (kind === "classroom") return "https://classroom.googleapis.com/v1/userProfiles/me";
  return "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";
}

export async function identifyAccount(input: {
  kind: AuthKind;
  accessToken: string;
  idToken?: string | null;
  fetchImpl?: typeof fetch;
  profileUrl?: string;
}): Promise<AccountIdentity> {
  const fromIdToken = signedClaims(input.idToken);
  if (fromIdToken) {
    const identity = identityFromClaims(fromIdToken);
    if (identity) return identity;
  }
  const fromAccess = signedClaims(input.accessToken);
  if (fromAccess) {
    const identity = identityFromClaims(fromAccess);
    if (identity) return identity;
  }
  const url = input.profileUrl ?? defaultProfileUrl(input.kind);
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Could not read the signed-in account (HTTP ${response.status}). The token was not saved.`);
  }
  const identity = identityFromProfile(input.kind, (await response.json()) as unknown);
  if (!identity) throw new Error("The signed-in account did not include an email or id. The token was not saved.");
  return identity;
}

export function readAccountStore(path: string): AccountStore {
  if (!existsSync(path)) return { version: 2, accounts: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (isStore(parsed)) {
    const accounts: Record<string, AccountToken> = {};
    for (const [key, value] of Object.entries(parsed.accounts)) {
      const account = parseAccount(value);
      if (!account) throw new Error(`Token file ${path} has an unreadable account "${key}"`);
      accounts[account.accountKey] = account;
    }
    return { version: 2, accounts };
  }
  if (isLegacyToken(parsed)) {
    const account = legacyAccount(parsed);
    return { version: 2, accounts: { [account.accountKey]: account } };
  }
  throw new Error(`Token file ${path} is not a School Pulse token store`);
}

export function writeAccountStore(path: string, store: AccountStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 2, accounts: store.accounts }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function upsertAccount(path: string, account: AccountToken): void {
  const store = readAccountStore(path);
  store.accounts[account.accountKey] = account;
  writeAccountStore(path, store);
}

export function listAccounts(path: string): AccountToken[] {
  return Object.values(readAccountStore(path).accounts).sort(
    (a, b) => a.studentId.localeCompare(b.studentId) || a.accountKey.localeCompare(b.accountKey),
  );
}

export function listAccountsFor(dataDir: string, kind: AuthKind): AccountToken[] {
  return listAccounts(tokenFilePath(dataDir, kind));
}

export function reauthNotices(dataDir: string): ReauthNotice[] {
  const notices: ReauthNotice[] = [];
  for (const kind of ["classroom", "onenote"] as const) {
    let accounts: AccountToken[] = [];
    try {
      accounts = listAccountsFor(dataDir, kind);
    } catch {
      continue;
    }
    for (const account of accounts) {
      if (!account.reauth_needed) continue;
      notices.push({ source: sourceForKind(kind), studentId: account.studentId });
    }
  }
  return notices;
}

export function toAccount(identity: AccountIdentity, studentId: string, token: StoredToken, now = new Date()): AccountToken {
  return {
    accountKey: identity.accountKey,
    email: identity.email,
    accountId: identity.accountId,
    studentId,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    scope: token.scope,
    expires_at: token.expires_at,
    reauth_needed: false,
    reauth_reason: null,
    updated_at: now.toISOString(),
  };
}

export function markReauth(account: AccountToken, reason: string, now = new Date()): AccountToken {
  return {
    ...account,
    reauth_needed: true,
    reauth_reason: reason.replace(/\s+/g, " ").trim().slice(0, 240),
    updated_at: now.toISOString(),
  };
}

export function applyRefreshed(account: AccountToken, token: StoredToken, now = new Date()): AccountToken {
  return {
    ...account,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? account.refresh_token,
    token_type: token.token_type || account.token_type,
    scope: token.scope || account.scope,
    expires_at: token.expires_at,
    reauth_needed: false,
    reauth_reason: null,
    updated_at: now.toISOString(),
  };
}

export function expiresSoon(expiresAt: string | null, now: Date, skewMs = REFRESH_SKEW_MS): boolean {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return false;
  return at - now.getTime() <= skewMs;
}

export async function ensureFreshAccount(input: {
  account: AccountToken;
  kind: AuthKind;
  clientId: string | null | undefined;
  clientSecret?: string | null;
  tokenUrl?: string;
  tenant?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  force?: boolean;
}): Promise<AccountToken> {
  const now = input.now ?? new Date();
  if (input.account.reauth_needed && !input.force) return input.account;
  if (!input.force && !expiresSoon(input.account.expires_at, now)) return input.account;
  if (!input.account.refresh_token) return markReauth(input.account, "no refresh token was stored", now);
  if (!input.clientId) {
    const variable = input.kind === "classroom" ? "SCHOOL_PULSE_GOOGLE_CLIENT_ID" : "SCHOOL_PULSE_GRAPH_CLIENT_ID";
    return markReauth(input.account, `set ${variable} so the refresh token can be used`, now);
  }
  try {
    const token = await refreshAccessToken({
      kind: input.kind,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.account.refresh_token,
      scope: input.kind === "onenote" ? scopesFor("onenote").join(" ") : input.account.scope,
      tokenUrl: input.tokenUrl,
      tenant: input.tenant,
      fetchImpl: input.fetchImpl,
      now,
    });
    return applyRefreshed(input.account, token, now);
  } catch (error) {
    const reason = error instanceof ReauthRequiredError
      ? error.reason
      : error instanceof Error
        ? error.message
        : "refresh failed";
    return markReauth(input.account, reason, now);
  }
}

export async function signInAccount(options: AuthFlowOptions & {
  studentId: string;
  storePath: string;
  profileUrl?: string;
}): Promise<AccountToken> {
  const studentId = assertStudentId(options.studentId);
  const flow = await runInstalledAppFlow({ ...options, skipWrite: true });
  const identity = await identifyAccount({
    kind: options.kind,
    accessToken: flow.token.access_token,
    idToken: flow.token.id_token,
    fetchImpl: options.fetchImpl,
    profileUrl: options.profileUrl,
  });
  const account = toAccount(identity, studentId, flow.token);
  upsertAccount(options.storePath, account);
  return account;
}

export function formatAuthStatus(input: { classroom: AccountToken[]; onenote: AccountToken[] }): string {
  return [...statusLines("classroom", input.classroom), ...statusLines("onenote", input.onenote)].join("\n");
}

function statusLines(kind: string, accounts: AccountToken[]): string[] {
  if (accounts.length === 0) return [`${kind}  no accounts`];
  return accounts.map((account) => {
    const who = account.email ?? account.accountKey;
    if (account.reauth_needed) {
      const why = account.reauth_reason ? ` (${account.reauth_reason})` : "";
      return `${kind}  ${who}  student ${account.studentId}  re-auth needed${why}`;
    }
    const refresh = account.refresh_token ? "refresh saved" : "no refresh token";
    const exp = account.expires_at ? `expires ${account.expires_at}` : "expiry unknown";
    return `${kind}  ${who}  student ${account.studentId}  ${refresh}  ${exp}`;
  });
}

function signedClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const claims = readJwtPayload(token);
  if (!claims) return null;
  const looksSigned = typeof claims.exp === "number" || typeof claims.iss === "string" || typeof claims.aud === "string";
  return looksSigned ? claims : null;
}

function identityFromProfile(kind: AuthKind, body: unknown): AccountIdentity | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (kind === "classroom") return identityFromClaims({ email: record.emailAddress, sub: record.id });
  const email = typeof record.mail === "string" && record.mail.trim() ? record.mail : record.userPrincipalName;
  return identityFromClaims({ email, sub: record.id });
}

function isStore(value: unknown): value is { version: 2; accounts: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && !!record.accounts && typeof record.accounts === "object" && !Array.isArray(record.accounts);
}

function isLegacyToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.access_token === "string" && !("accounts" in record);
}

function legacyAccount(token: StoredToken): AccountToken {
  return {
    accountKey: "legacy",
    email: null,
    accountId: null,
    studentId: "legacy",
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    token_type: token.token_type || "Bearer",
    scope: token.scope || "",
    expires_at: token.expires_at ?? null,
    reauth_needed: false,
    reauth_reason: null,
    updated_at: new Date(0).toISOString(),
  };
}

function parseAccount(value: unknown): AccountToken | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.access_token !== "string" || typeof record.accountKey !== "string" || typeof record.studentId !== "string") return null;
  return {
    accountKey: record.accountKey,
    email: typeof record.email === "string" ? record.email : null,
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    studentId: record.studentId,
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : null,
    token_type: typeof record.token_type === "string" ? record.token_type : "Bearer",
    scope: typeof record.scope === "string" ? record.scope : "",
    expires_at: typeof record.expires_at === "string" ? record.expires_at : null,
    reauth_needed: record.reauth_needed === true,
    reauth_reason: typeof record.reauth_reason === "string" ? record.reauth_reason : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : new Date(0).toISOString(),
  };
}

function emailOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes("@") || trimmed.startsWith("@") || trimmed.endsWith("@") || /\s/.test(trimmed)) return null;
  return trimmed;
}

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
