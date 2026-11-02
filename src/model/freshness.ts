import { formatWhen } from "./dates.js";

export type Freshness = "fresh" | "aging" | "stale";

export const SOURCE_LABELS: Record<string, string> = {
  powerschool: "PowerSchool",
  "google-classroom": "Classroom",
  onenote: "OneNote",
  generic: "Generic",
};

export const SOURCE_ORDER = ["powerschool", "google-classroom", "onenote", "generic"];

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function freshnessForAge(ageMs: number): Freshness {
  if (ageMs >= 48 * 3_600_000) return "stale";
  if (ageMs >= 12 * 3_600_000) return "aging";
  return "fresh";
}

export function freshnessBadge(source: string, fetchedAt: string, now: Date): { text: string; state: Freshness } {
  const age = Math.max(0, now.getTime() - new Date(fetchedAt).getTime());
  const state = freshnessForAge(age);
  const when = formatWhen(fetchedAt, now);
  const name = sourceLabel(source);
  if (state === "fresh") return { text: `${name} · ${when}`, state };
  return { text: `${name} · ${state} · ${when}`, state };
}

export function compareSources(a: string, b: string): number {
  const ai = SOURCE_ORDER.indexOf(a);
  const bi = SOURCE_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}
