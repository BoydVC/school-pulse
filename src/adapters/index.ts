import type { SnapshotFormat, Source } from "../domain/index.ts";
import type { SchoolAdapter } from "./adapter.ts";
import { classroomAdapter } from "./classroom.ts";
import { genericAdapter } from "./generic.ts";
import { onenoteAdapter } from "./onenote.ts";
import { powerschoolAdapter } from "./powerschool.ts";

export { explainAdapter, type AdapterFailure, type SchoolAdapter } from "./adapter.ts";
export { classroomAdapter, genericAdapter, onenoteAdapter, powerschoolAdapter };

const adapters: Record<Source, SchoolAdapter> = {
  powerschool: powerschoolAdapter,
  onenote: onenoteAdapter,
  "google-classroom": classroomAdapter,
  generic: genericAdapter,
};

export function adapterFor(source: Source): SchoolAdapter {
  return adapters[source];
}

export function formatFor(filename: string): SnapshotFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

export function sourceFromInboxPath(file: string): Source | null {
  const parts = file.split(/[\\/]+/);
  const inbox = parts.lastIndexOf("inbox");
  const source = inbox >= 0 ? parts[inbox + 1] : undefined;
  if (source === "powerschool" || source === "onenote" || source === "google-classroom" || source === "generic") {
    return source;
  }
  return null;
}
