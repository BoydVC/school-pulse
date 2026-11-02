import { mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { SOURCES, type Source } from "../domain/index.ts";
import { formatFor, sourceFromInboxPath } from "../adapters/index.ts";

export function ensureInbox(dataDir: string): void {
  for (const source of SOURCES) mkdirSync(join(dataDir, "inbox", source), { recursive: true });
}

export function watchInbox(dataDir: string, onFile: (file: string, source: Source) => void): { close(): void } {
  ensureInbox(dataDir);
  const inbox = join(dataDir, "inbox");
  const timers = new Map<string, NodeJS.Timeout>();
  const deliver = (file: string) => {
    const source = sourceFromInboxPath(file);
    if (!source || !formatFor(file)) return;
    try {
      if (!statSync(file).isFile()) return;
    } catch {
      return;
    }
    onFile(file, source);
  };
  const schedule = (file: string) => {
    const existing = timers.get(file);
    if (existing) clearTimeout(existing);
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        deliver(file);
      }, 200),
    );
  };
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.isFile()) schedule(full);
    }
  };
  scan(inbox);
  const watcher: FSWatcher = watch(inbox, { recursive: true }, (_event, name) => {
    if (!name) return;
    schedule(join(inbox, name.toString()));
  });
  return {
    close() {
      watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
    },
  };
}

export function readSnapshotFile(file: string): string {
  return readFileSync(file, "utf8");
}
