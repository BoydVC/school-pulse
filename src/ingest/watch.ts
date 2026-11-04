import { mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { KNOWN_SOURCES, parseSnapshot, sourceFromInboxPath } from "../adapters/index.js";
import { deliverWebhooks } from "../alerts/alerts.js";
import type { DatabaseSync } from "node:sqlite";
import { ingestSnapshot, type IngestResult } from "./ingest.js";

export function startWatcher(options: {
  dataDir: string;
  db: DatabaseSync;
  onResult?: (result: IngestResult, file: string) => void;
}): { close: () => void } {
  const inbox = join(options.dataDir, "inbox");
  for (const source of KNOWN_SOURCES) mkdirSync(join(inbox, source), { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(inbox, { recursive: true }, (_event, name) => {
      if (closed || !name) return;
      const file = join(inbox, name.toString());
      const existing = timers.get(file);
      if (existing) clearTimeout(existing);
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          if (!closed) void ingestFile(options.db, file, options.onResult);
        }, 150),
      );
    });
  } catch (error) {
    throw new Error(`Could not watch ${inbox}: ${error instanceof Error ? error.message : "unknown"}`);
  }
  for (const source of KNOWN_SOURCES) {
    const dir = join(inbox, source);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) void ingestFile(options.db, join(dir, name), options.onResult);
  }
  return {
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watcher.close();
    },
  };
}

async function ingestFile(db: DatabaseSync, file: string, onResult?: (result: IngestResult, file: string) => void): Promise<void> {
  const name = basename(file);
  if (name.startsWith(".") || name.endsWith(".tmp") || name.endsWith("~")) return;
  const extension = name.toLowerCase();
  if (!extension.endsWith(".json") && !extension.endsWith(".html") && !extension.endsWith(".htm") && !extension.endsWith(".csv")) return;
  try {
    if (!statSync(file).isFile()) return;
  } catch {
    return;
  }
  let lastError = "empty file";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = readFileSync(file, "utf8");
      if (!raw.trim()) throw new Error("File is empty");
      const now = new Date();
      const snapshot = parseSnapshot({ source: sourceFromInboxPath(file), filename: file, raw, now });
      const result = ingestSnapshot(db, snapshot, now);
      await deliverWebhooks(db, result.alerts).catch((error: unknown) => {
        console.error(`school-pulse: webhook failed: ${error instanceof Error ? error.message : "unknown"}`);
      });
      onResult?.(result, file);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  console.error(`school-pulse: could not ingest ${file}: ${lastError}`);
}
