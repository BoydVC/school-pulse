import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function helpText(): string {
  return `School Pulse — a local, read-only view of grades and homework.

Usage
  school-pulse demo [--port 4173] [--data ./data]
  school-pulse serve [--port 4173] [--host 127.0.0.1] [--data ./data]
  school-pulse ingest <file> [--source powerschool|onenote|google-classroom|generic] [--data ./data]

The demo seeds two synthetic students and watches data/inbox/<source>/.
Real records stay in the data directory (or SCHOOL_PULSE_DATA). This tool never
submits work or writes back to a school system.`;
}
