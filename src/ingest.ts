import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { parseSnapshot } from './adapters/index.js';
import { sourceFromFolder } from './adapters/index.js';
import { AdapterError, type Source } from './model.js';
import type { ApplyResult, ChangeRow, Store } from './store.js';

const EXTENSIONS = new Set(['.json', '.html', '.htm', '.csv']);

export interface IngestReport {
  file: string;
  source: Source | null;
  unchanged: boolean;
  changes: ChangeRow[];
  result: ApplyResult | null;
  notes: string[];
  error?: string;
}

export function ingestText(store: Store, text: string, hint: Source | null, fileLabel: string): IngestReport {
  const fingerprint = createHash('sha256').update(text).digest('hex');
  if (store.hasFingerprint(fingerprint)) {
    return { file: fileLabel, source: hint, unchanged: true, changes: [], result: null, notes: [] };
  }
  try {
    const batch = parseSnapshot(text, hint ? { sourceHint: hint } : {});
    const result = store.apply(batch);
    store.rememberFingerprint(fingerprint, batch.source, batch.fetchedAt);
    const unchanged = result.changes.length === 0 && result.inserted === 0 && result.updated === 0 && result.dropped === 0 && result.refreshed === 0;
    return {
      file: fileLabel,
      source: batch.source,
      unchanged,
      changes: result.changes,
      result,
      notes: batch.notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AdapterError || error instanceof SyntaxError) {
      return { file: fileLabel, source: hint, unchanged: false, changes: [], result: null, notes: [], error: message };
    }
    throw error;
  }
}

export function ingestFile(store: Store, file: string): IngestReport {
  const text = readFileSync(file, 'utf8');
  const hint = sourceFromFolder(basename(dirname(file)));
  return ingestText(store, text, hint, file);
}

export function listInboxFiles(inbox: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (EXTENSIONS.has(extname(entry).toLowerCase())) found.push(full);
    }
  };
  walk(inbox);
  return found.sort((a, b) => relative(inbox, a).localeCompare(relative(inbox, b)));
}

export function ingestInbox(store: Store, inbox: string): IngestReport[] {
  mkdirSync(inbox, { recursive: true });
  for (const folder of ['powerschool', 'onenote', 'google-classroom', 'generic']) {
    mkdirSync(join(inbox, folder), { recursive: true });
  }
  return listInboxFiles(inbox).map((file) => ingestFile(store, file));
}

export function watchInbox(inbox: string, onFile: (file: string) => void): FSWatcher {
  mkdirSync(inbox, { recursive: true });
  const pending = new Map<string, NodeJS.Timeout>();
  const watcher = watch(inbox, { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = join(inbox, name.toString());
    if (!EXTENSIONS.has(extname(file).toLowerCase())) return;
    const existing = pending.get(file);
    if (existing) clearTimeout(existing);
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      try {
        if (statSync(file).isFile()) onFile(file);
      } catch {
        // file disappeared between events
      }
    }, 150));
  });
  return watcher;
}
