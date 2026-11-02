import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseSnapshot } from "../adapters/index.js";
import { fetchClassroomSnapshot } from "../faithful/fetch/classroom.js";
import { fetchOneNoteSnapshot } from "../faithful/fetch/onenote.js";
import { ingestSnapshot, type IngestResult } from "../ingest/ingest.js";
import {
  ensureFreshAccount,
  listAccountsFor,
  markReauth,
  sourceForKind,
  tokenFilePath,
  upsertAccount,
  type AccountToken,
} from "./accounts.js";
import { ReauthRequiredError, type AuthKind } from "./oauth.js";

export interface SyncResult {
  wrote: boolean;
  messages: string[];
  ingested: IngestResult[];
}

export async function syncAccounts(options: {
  dataDir: string;
  db: DatabaseSync;
  fetchImpl?: typeof fetch;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<SyncResult> {
  const env = options.env ?? {};
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = readConfig(options.dataDir);
  const result: SyncResult = { wrote: false, messages: [], ingested: [] };
  const classroom = await syncKind({
    kind: "classroom",
    dataDir: options.dataDir,
    db: options.db,
    fetchImpl,
    now,
    config,
    clientId: textEnv(env, "SCHOOL_PULSE_GOOGLE_CLIENT_ID"),
    clientSecret: textEnv(env, "SCHOOL_PULSE_GOOGLE_CLIENT_SECRET"),
    tenant: textEnv(env, "SCHOOL_PULSE_GRAPH_TENANT") ?? undefined,
    envToken: textEnv(env, "SCHOOL_PULSE_CLASSROOM_TOKEN"),
    result,
  });
  const onenote = await syncKind({
    kind: "onenote",
    dataDir: options.dataDir,
    db: options.db,
    fetchImpl,
    now,
    config,
    clientId: textEnv(env, "SCHOOL_PULSE_GRAPH_CLIENT_ID"),
    clientSecret: textEnv(env, "SCHOOL_PULSE_GRAPH_CLIENT_SECRET"),
    tenant: textEnv(env, "SCHOOL_PULSE_GRAPH_TENANT") ?? undefined,
    envToken: textEnv(env, "SCHOOL_PULSE_GRAPH_TOKEN"),
    result,
  });
  if (!classroom && !onenote && result.messages.length === 0) {
    result.messages.push("No tokens configured. Run school-pulse auth classroom --student <id> or school-pulse auth onenote --student <id>. PowerSchool stays a saved snapshot.");
  }
  return result;
}

async function syncKind(input: {
  kind: AuthKind;
  dataDir: string;
  db: DatabaseSync;
  fetchImpl: typeof fetch;
  now: Date;
  config: { school?: string; studentName?: string };
  clientId: string | null;
  clientSecret: string | null;
  tenant?: string;
  envToken: string | null;
  result: SyncResult;
}): Promise<boolean> {
  const path = tokenFilePath(input.dataDir, input.kind);
  const label = input.kind === "classroom" ? "Classroom" : "OneNote";
  const source = sourceForKind(input.kind);
  let accounts: AccountToken[];
  try {
    accounts = listAccountsFor(input.dataDir, input.kind);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read tokens";
    input.result.messages.push(`${label}: ${message}`);
    return true;
  }
  let used = false;
  for (const account of accounts) {
    used = true;
    let current = await ensureFreshAccount({
      account,
      kind: input.kind,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      tenant: input.tenant,
      fetchImpl: input.fetchImpl,
      now: input.now,
    });
    if (changed(account, current)) upsertAccount(path, current);
    if (current.reauth_needed) {
      input.result.messages.push(`${label} ${current.studentId}: re-auth needed (${current.reauth_reason ?? "refresh failed"})`);
      continue;
    }
    const studentName = accounts.length === 1 ? input.config.studentName : undefined;
    try {
      const snapshot = await fetchSnapshot(input.kind, {
        token: current.access_token,
        fetchImpl: input.fetchImpl,
        school: input.config.school,
        studentName,
        onUnauthorized: async () => {
          const next = await ensureFreshAccount({
            account: current,
            kind: input.kind,
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            tenant: input.tenant,
            fetchImpl: input.fetchImpl,
            now: input.now,
            force: true,
          });
          upsertAccount(path, next);
          current = next;
          if (next.reauth_needed) throw new ReauthRequiredError(next.reauth_reason ?? "refresh failed");
          return next.access_token;
        },
      });
      input.result.ingested.push(writeSyncFile(input.dataDir, input.db, source, current.studentId, snapshot, input.now));
      input.result.wrote = true;
    } catch (error) {
      const reason = reauthReason(error);
      if (reason) {
        const marked = markReauth(current, reason, input.now);
        upsertAccount(path, marked);
        input.result.messages.push(`${label} ${marked.studentId}: re-auth needed (${marked.reauth_reason ?? reason})`);
        continue;
      }
      const message = error instanceof Error ? error.message : "sync failed";
      input.result.messages.push(`${label} ${current.studentId}: ${message}`);
    }
  }
  if (!used && input.envToken) {
    try {
      const snapshot = await fetchSnapshot(input.kind, {
        token: input.envToken,
        fetchImpl: input.fetchImpl,
        school: input.config.school,
        studentName: input.config.studentName,
      });
      input.result.ingested.push(writeSyncFile(input.dataDir, input.db, source, "env", snapshot, input.now));
      input.result.wrote = true;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync failed";
      input.result.messages.push(`${label} env: ${message}`);
      return true;
    }
  }
  return used;
}

async function fetchSnapshot(kind: AuthKind, options: {
  token: string;
  fetchImpl: typeof fetch;
  school?: string;
  studentName?: string;
  onUnauthorized?: () => Promise<string>;
}): Promise<unknown> {
  if (kind === "classroom") return fetchClassroomSnapshot(options);
  return fetchOneNoteSnapshot(options);
}

function writeSyncFile(dataDir: string, db: DatabaseSync, source: string, studentId: string, snapshot: unknown, now: Date): IngestResult {
  const file = join(dataDir, "inbox", source, `sync-${studentId}-${randomBytes(4).toString("hex")}.json`);
  mkdirSync(join(dataDir, "inbox", source), { recursive: true });
  const raw = JSON.stringify(snapshot);
  writeFileSync(file, raw);
  const parsed = parseSnapshot({ source, filename: file, raw, now });
  return ingestSnapshot(db, parsed, now);
}

function changed(before: AccountToken, after: AccountToken): boolean {
  return before.access_token !== after.access_token
    || before.refresh_token !== after.refresh_token
    || before.expires_at !== after.expires_at
    || before.reauth_needed !== after.reauth_needed
    || before.reauth_reason !== after.reauth_reason;
}

function reauthReason(error: unknown): string | null {
  if (error instanceof ReauthRequiredError) return error.reason;
  if (error instanceof Error && /\b401\b/.test(error.message)) return "the source rejected the access token";
  return null;
}

function textEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readConfig(dataDir: string): { school?: string; studentName?: string } {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as { school?: string; studentName?: string };
}
