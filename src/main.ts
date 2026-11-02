import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInstalledAppFlow, type AuthKind } from "./auth/oauth.js";
import { fetchClassroomSnapshot } from "./faithful/fetch/classroom.js";
import { fetchOneNoteSnapshot } from "./faithful/fetch/onenote.js";
import { parseArgs } from "node:util";
import { parseSnapshot, sourceFromInboxPath } from "./adapters/index.js";
import { deliverWebhooks } from "./alerts/alerts.js";
import { seedDemo } from "./demo/seed.js";
import { ingestSnapshot, type IngestResult } from "./ingest/ingest.js";
import { startWatcher } from "./ingest/watch.js";
import { startServer } from "./server/server.js";
import { openDatabase } from "./store/db.js";
import { repoRoot } from "./util/root.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      data: { type: "string" },
      source: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    console.log(helpText());
    return;
  }
  const dataDir = resolveDataDir(values.data);
  if (command === "auth") {
    await runAuth(positionals[1], dataDir);
    return;
  }
  const db = openDatabase(resolve(dataDir, "school-pulse.sqlite"));
  if (command === "ingest") {
    const file = positionals[1];
    if (!file) throw new Error("Usage: school-pulse ingest <file> [--source <name>]");
    const raw = readFileSync(resolve(file), "utf8");
    const now = new Date();
    const snapshot = parseSnapshot({
      source: values.source ?? sourceFromInboxPath(resolve(file)),
      filename: resolve(file),
      raw,
      now,
    });
    const result = ingestSnapshot(db, snapshot, now);
    await deliverWebhooks(db, result.alerts).catch((error: unknown) => {
      console.error(`Webhook failed: ${error instanceof Error ? error.message : "unknown"}`);
    });
    printResult(result);
    return;
  }
  if (command === "sync") {
    await runSync(dataDir, db);
    return;
  }
  if (command === "serve" || command === "demo") {
    if (command === "demo") seedDemo(db, new Date());
    const host = values.host ?? "127.0.0.1";
    const port = values.port ? Number(values.port) : 4173;
    if (!Number.isFinite(port)) throw new Error("Port must be a number");
    const running = await startServer({ db, host, port });
    const watcher = startWatcher({
      dataDir,
      db,
      onResult(result, file) {
        if (result.unchanged) console.log(`No changes from ${file}`);
        else printResult(result);
        running.hub.publish(result);
      },
    });
    const root = repoRoot();
    if (command === "demo") {
      console.log(`School Pulse`);
      console.log(`Open ${running.url}`);
      console.log("");
      console.log("Synthetic household: Student A (Pinecrest Middle) and Student B (Riverbend Elementary).");
      console.log("Sources: PowerSchool, Classroom, OneNote. Nothing here is a real student.");
      console.log("");
      console.log("Drop a live update into the inbox (the page animates when it lands):");
      console.log(`  cp ${resolve(root, "fixtures/demo/live-update.json")} ${resolve(dataDir, "inbox", "powerschool", "live-update.json")}`);
    } else {
      console.log(`School Pulse listening on ${running.url}`);
      console.log(`Inbox: ${resolve(dataDir, "inbox")}`);
    }
    await new Promise<void>((done) => {
      const stop = (): void => {
        watcher.close();
        void running.close().finally(() => done());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${helpText()}`);
}

function printResult(result: IngestResult): void {
  if (result.unchanged) {
    console.log("No changes. Already imported.");
    return;
  }
  if (result.changes.length === 0) {
    console.log(`Imported ${result.assignmentsInserted} new assignments, ${result.gradesInserted} grade points.`);
    return;
  }
  for (const change of result.changes) console.log(change.summary);
}

export function resolveDataDir(flag?: string): string {
  if (flag) return resolve(flag);
  if (process.env.SCHOOL_PULSE_DATA) return resolve(process.env.SCHOOL_PULSE_DATA);
  return resolve(process.cwd(), "data");
}

async function runSync(dataDir: string, db: ReturnType<typeof openDatabase>): Promise<void> {
  const config = readConfig(dataDir);
  let wrote = false;
  const classroomToken = readToken(dataDir, "google-classroom.json", "SCHOOL_PULSE_CLASSROOM_TOKEN");
  if (classroomToken) {
    const snapshot = await fetchClassroomSnapshot({ token: classroomToken, school: config.school, studentName: config.studentName });
    wrote = writeSyncFile(dataDir, db, "google-classroom", snapshot) || wrote;
  }
  const graphToken = readToken(dataDir, "microsoft-graph.json", "SCHOOL_PULSE_GRAPH_TOKEN");
  if (graphToken) {
    const snapshot = await fetchOneNoteSnapshot({ token: graphToken, school: config.school, studentName: config.studentName });
    wrote = writeSyncFile(dataDir, db, "onenote", snapshot) || wrote;
  }
  if (!wrote) {
    console.log("No tokens configured. Run school-pulse auth classroom or school-pulse auth onenote. PowerSchool stays a saved snapshot.");
  }
}

function writeSyncFile(dataDir: string, db: ReturnType<typeof openDatabase>, source: string, snapshot: unknown): boolean {
  const file = join(dataDir, "inbox", source, `sync-${Date.now()}.json`);
  mkdirSync(join(dataDir, "inbox", source), { recursive: true });
  const raw = JSON.stringify(snapshot);
  writeFileSync(file, raw);
  const now = new Date();
  const parsed = parseSnapshot({ source, filename: file, raw, now });
  printResult(ingestSnapshot(db, parsed, now));
  return true;
}

function readToken(dataDir: string, file: string, envName: string): string | null {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const path = join(dataDir, "tokens", file);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { access_token?: string };
  return parsed.access_token ?? null;
}

function readConfig(dataDir: string): { school?: string; studentName?: string } {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as { school?: string; studentName?: string };
}

async function runAuth(kind: string | undefined, dataDir: string): Promise<void> {
  if (kind !== "classroom" && kind !== "onenote") {
    throw new Error("Usage: school-pulse auth classroom|onenote");
  }
  const clientId = kind === "classroom" ? process.env.SCHOOL_PULSE_GOOGLE_CLIENT_ID : process.env.SCHOOL_PULSE_GRAPH_CLIENT_ID;
  if (!clientId) {
    const variable = kind === "classroom" ? "SCHOOL_PULSE_GOOGLE_CLIENT_ID" : "SCHOOL_PULSE_GRAPH_CLIENT_ID";
    throw new Error(`Set ${variable} to your installed-app client id. See docs/ADAPTERS.md.`);
  }
  const clientSecret = kind === "classroom" ? process.env.SCHOOL_PULSE_GOOGLE_CLIENT_SECRET : process.env.SCHOOL_PULSE_GRAPH_CLIENT_SECRET;
  const tokenPath = join(dataDir, "tokens", kind === "classroom" ? "google-classroom.json" : "microsoft-graph.json");
  console.log("Open this URL and approve read-only access. Waiting on 127.0.0.1 for the redirect.");
  const result = await runInstalledAppFlow({
    kind: kind as AuthKind,
    clientId,
    clientSecret: clientSecret || null,
    tokenPath,
    tenant: process.env.SCHOOL_PULSE_GRAPH_TENANT,
    onAuthorizeUrl: (url) => console.log(url),
  });
  console.log(`Stored token at ${result.path}`);
}

function helpText(): string {
  return `School Pulse — a local, read-only view of grades and homework.

Usage
  school-pulse demo [--port 4173] [--data ./data]
  school-pulse serve [--port 4173] [--host 127.0.0.1] [--data ./data]
  school-pulse ingest <file> [--source powerschool|onenote|google-classroom|generic] [--data ./data]
  school-pulse auth classroom
  school-pulse auth onenote
  school-pulse sync [--data ./data]

The demo seeds two synthetic students and watches data/inbox/<source>/.
Today and this week use SCHOOL_PULSE_TZ (default America/New_York).
Real records and OAuth tokens stay in the data directory (or SCHOOL_PULSE_DATA).
This tool never submits work or writes back to a school system.`;
}
