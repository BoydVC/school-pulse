import { parseSnapshot as parseFaithful } from "../faithful/adapters/index.js";
import { AdapterError, isSource } from "../faithful/model.js";
import { expandDemoTokens, stripBom } from "../model/tokens.js";
import { activeTimezone } from "../time/zone.js";
import { fromFaithful, usableFaithful } from "./bridge.js";
import { parseClassroom } from "./classroom.js";
import { parseGeneric } from "./generic.js";
import { parseOneNote } from "./onenote.js";
import { parsePowerSchool } from "./powerschool.js";
import type { NormalizedSnapshot } from "./types.js";

export const KNOWN_SOURCES = ["powerschool", "onenote", "google-classroom", "generic"] as const;

export function parseSnapshot(input: {
  source?: string | null;
  filename: string;
  raw: string;
  now: Date;
}): NormalizedSnapshot {
  const raw = expandDemoTokens(stripBom(input.raw), input.now);
  if (isHtmlFragment(raw)) {
    throw new Error("HTML fragment is not a saved school page");
  }
  const hinted = input.source && input.source !== "auto" ? input.source : sourceFromInboxPath(input.filename);
  try {
    const batch = parseFaithful(raw, {
      now: input.now.toISOString(),
      sourceHint: hinted && isSource(hinted) ? hinted : null,
    });
    if (usableFaithful(batch) || (batch.source === "generic" && explicitlyGeneric(raw, hinted))) return fromFaithful(batch, activeTimezone());
  } catch (error) {
    if (error instanceof AdapterError && explicitlyGeneric(raw, hinted)) throw error;
    if (error instanceof AdapterError && /missing the section frn/i.test(error.message) && !/frn=/i.test(raw)) {
      throw new Error("PowerSchool scores page is missing the section frn");
    }
    if (error instanceof AdapterError && /unknown status|must be an array|is not valid/i.test(error.message)) {
      if (/unknown status/i.test(error.message)) throw new Error(`Unknown assignment status "${error.message}"`);
      throw error;
    }
    if (!(error instanceof AdapterError) && !(error instanceof SyntaxError)) {
      const message = error instanceof Error ? error.message : "Could not read snapshot";
      throw new Error(message);
    }
  }
  const legacy = parseLegacy(raw, input);
  if (looksLikeHtml(raw) && legacy.students.length + legacy.courses.length + legacy.assignments.length + legacy.grades.length === 0) {
    throw new Error("HTML fragment is not a saved school page");
  }
  return legacy;
}

function explicitlyGeneric(raw: string, hint: string | null): boolean {
  if (hint === "generic") return true;
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    const header = text.split(/\r?\n/, 1)[0] ?? "";
    return /^student\b/i.test(header) && /\bcourse\b/i.test(header);
  }
  try {
    const json = JSON.parse(text) as { source?: unknown };
    return json.source === "generic";
  } catch {
    return false;
  }
}

function looksLikeHtml(raw: string): boolean {
  return /^\s*</.test(raw);
}

function isHtmlFragment(raw: string): boolean {
  const text = raw.trim();
  if (!looksLikeHtml(text)) return false;
  if (/<html|<body|<!doctype|<head/i.test(text)) return false;
  if (/frn=|studname|account-name|school-pulse-student|data-tag=/i.test(text)) return false;
  return true;
}

function parseLegacy(raw: string, input: { source?: string | null; filename: string; now: Date }): NormalizedSnapshot {
  const source = resolveSource(input.source, raw, input.filename);
  if (source === "powerschool") return parsePowerSchool(raw, input.now);
  if (source === "onenote") return parseOneNote(raw, input.now);
  if (source === "google-classroom") return parseClassroom(raw, input.now);
  if (source === "generic") return parseGeneric(raw, input.filename, input.now);
  throw new Error(`Unknown source "${source}". Use powerschool, onenote, google-classroom, or generic.`);
}

export function sourceFromInboxPath(file: string): string | null {
  const parts = file.split(/[/\\]/);
  const index = parts.lastIndexOf("inbox");
  const folder = index >= 0 ? parts[index + 1] : null;
  if (folder && (KNOWN_SOURCES as readonly string[]).includes(folder)) return folder;
  return null;
}

function resolveSource(explicit: string | null | undefined, raw: string, filename: string): string {
  if (explicit && explicit !== "auto") return explicit;
  const hinted = sourceFromInboxPath(filename);
  if (hinted) return hinted;
  return sniff(raw, filename);
}

function sniff(raw: string, filename: string): string {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".csv")) return "generic";
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    const lower = text.slice(0, 4000).toLowerCase();
    if (lower.includes("coursework") || lower.includes("studentsubmissions")) return "google-classroom";
    if (lower.includes("finalgrades") || lower.includes("sectionid")) return "powerschool";
    if (lower.includes("onenote") || lower.includes("parentsection")) return "onenote";
    return "generic";
  }
  const lower = text.slice(0, 4000).toLowerCase();
  if (lower.includes("assignment") && (lower.includes("score") || lower.includes("due date"))) return "powerschool";
  return "onenote";
}
