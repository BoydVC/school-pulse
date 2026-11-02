import { sha256 } from "../hash.ts";
import type { Change, IsoInstant } from "../domain/index.ts";
import { formatGradeNumber } from "../domain/index.ts";

export type AlertRule =
  | { readonly kind: "grade_below"; readonly enabled: boolean; readonly threshold: number }
  | { readonly kind: "missing_above"; readonly enabled: boolean; readonly count: number }
  | { readonly kind: "grade_drop"; readonly enabled: boolean; readonly points: number };

export type AlertEvent = {
  readonly id: string;
  readonly kind: AlertRule["kind"];
  readonly studentId: string;
  readonly message: string;
  readonly at: IsoInstant;
  readonly payload: string;
};

export function planAlerts(input: {
  readonly rules: readonly AlertRule[];
  readonly changes: readonly Change[];
  readonly missing: readonly { readonly studentId: string; readonly count: number }[];
  readonly at: IsoInstant;
}): AlertEvent[] {
  const events: AlertEvent[] = [];
  const below = input.rules.find((rule) => rule.kind === "grade_below" && rule.enabled);
  const drop = input.rules.find((rule) => rule.kind === "grade_drop" && rule.enabled);
  const missing = input.rules.find((rule) => rule.kind === "missing_above" && rule.enabled);
  for (const change of input.changes) {
    if (change.kind !== "grade") continue;
    if (below && below.kind === "grade_below" && change.to.percent !== null && change.to.percent < below.threshold) {
      events.push(
        event(
          "grade_below",
          change.studentId,
          `${change.courseName} is at ${formatGradeNumber(change.to)}, below ${below.threshold}`,
          input.at,
          { changeId: change.id, threshold: below.threshold },
        ),
      );
    }
    if (
      drop &&
      drop.kind === "grade_drop" &&
      change.from.percent !== null &&
      change.to.percent !== null &&
      change.from.percent - change.to.percent >= drop.points
    ) {
      events.push(
        event(
          "grade_drop",
          change.studentId,
          `${change.courseName} dropped from ${formatGradeNumber(change.from)} to ${formatGradeNumber(change.to)}`,
          input.at,
          { changeId: change.id, points: drop.points },
        ),
      );
    }
  }
  if (missing && missing.kind === "missing_above") {
    for (const row of input.missing) {
      if (row.count > missing.count) {
        events.push(
          event(
            "missing_above",
            row.studentId,
            `${row.count} missing assignments, above ${missing.count}`,
            input.at,
            { count: row.count, threshold: missing.count },
          ),
        );
      }
    }
  }
  return events;
}

function event(
  kind: AlertRule["kind"],
  studentId: string,
  message: string,
  at: IsoInstant,
  payload: Record<string, string | number>,
): AlertEvent {
  return {
    id: `alrt_${sha256(`${kind}|${studentId}|${message}`).slice(0, 24)}`,
    kind,
    studentId,
    message,
    at,
    payload: JSON.stringify(payload),
  };
}

export function parseRuleList(input: unknown): AlertRule[] | string {
  if (!Array.isArray(input)) return "rules must be an array";
  const rules: AlertRule[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) return "each rule must be an object";
    const record = entry as Record<string, unknown>;
    const kind = record["kind"];
    const enabled = record["enabled"];
    if (typeof enabled !== "boolean") return "enabled must be true or false";
    if (kind === "grade_below") {
      const threshold = record["threshold"];
      if (typeof threshold !== "number" || threshold < 0 || threshold > 100) return "grade_below threshold must be 0..100";
      rules.push({ kind, enabled, threshold });
    } else if (kind === "missing_above") {
      const count = record["count"];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return "missing_above count must be a whole number";
      rules.push({ kind, enabled, count });
    } else if (kind === "grade_drop") {
      const points = record["points"];
      if (typeof points !== "number" || points <= 0 || points > 100) return "grade_drop points must be between 0 and 100";
      rules.push({ kind, enabled, points });
    } else {
      return "unknown alert rule";
    }
  }
  const kinds = new Set(rules.map((rule) => rule.kind));
  if (kinds.size !== rules.length) return "duplicate alert rule";
  return rules;
}
