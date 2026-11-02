import { letterGrade, percent, type LetterGrade, type Percent } from "./brand.ts";
import { err, ok, unreachable, type Result } from "./result.ts";
import type { DomainError } from "./brand.ts";

/**
 * A grade always carries a percent, a letter, or both.
 * An empty snapshot cannot be constructed.
 */
export type GradeValue =
  | { readonly percent: Percent; readonly letter: LetterGrade | null }
  | { readonly percent: null; readonly letter: LetterGrade };

export function gradeValue(
  rawPercent: number | null,
  rawLetter: string | null,
): Result<GradeValue, DomainError> {
  const parsedPercent = rawPercent === null ? null : percent(rawPercent);
  if (parsedPercent && !parsedPercent.ok) return parsedPercent;
  const parsedLetter = rawLetter === null || rawLetter.trim() === "" ? null : letterGrade(rawLetter);
  if (parsedLetter && !parsedLetter.ok) return parsedLetter;
  const pct = parsedPercent === null ? null : parsedPercent.value;
  const letter = parsedLetter === null ? null : parsedLetter.value;
  if (pct !== null) return ok({ percent: pct, letter });
  if (letter !== null) return ok({ percent: null, letter });
  return err({ kind: "empty_grade" });
}

export function sameGrade(a: GradeValue, b: GradeValue): boolean {
  return a.percent === b.percent && a.letter === b.letter;
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatGradeNumber(value: GradeValue): string {
  if (value.percent !== null) return formatPercent(value.percent);
  return value.letter;
}

export type UngradedPoints = {
  readonly kind: "ungraded";
  readonly possible: number | null;
};

export type GradedPoints = {
  readonly kind: "graded";
  readonly earned: number;
  readonly possible: number;
};

export type MissingPoints = {
  readonly kind: "missing";
  readonly earned: 0;
  readonly possible: number | null;
};

export type LatePoints = {
  readonly kind: "late";
  readonly earned: number | null;
  readonly possible: number | null;
};

function nonNegative(value: number, field: "earned" | "possible"): Result<number, DomainError> {
  if (!Number.isFinite(value) || value < 0) return err({ kind: "bad_points", field, value });
  return ok(value);
}

function positivePoints(value: number): Result<number, DomainError> {
  const parsed = nonNegative(value, "possible");
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) return err({ kind: "bad_points", field: "possible", value });
  return parsed;
}

export function ungradedPoints(possible: number | null): Result<UngradedPoints, DomainError> {
  if (possible === null) return ok({ kind: "ungraded", possible: null });
  const parsed = positivePoints(possible);
  if (!parsed.ok) return parsed;
  return ok({ kind: "ungraded", possible: parsed.value });
}

export function gradedPoints(earned: number, possible: number): Result<GradedPoints, DomainError> {
  const parsedEarned = nonNegative(earned, "earned");
  if (!parsedEarned.ok) return parsedEarned;
  const parsedPossible = positivePoints(possible);
  if (!parsedPossible.ok) return parsedPossible;
  if (parsedEarned.value > parsedPossible.value) {
    return err({
      kind: "earned_exceeds_possible",
      earned: parsedEarned.value,
      possible: parsedPossible.value,
    });
  }
  return ok({ kind: "graded", earned: parsedEarned.value, possible: parsedPossible.value });
}

export function missingPoints(possible: number | null): Result<MissingPoints, DomainError> {
  if (possible === null) return ok({ kind: "missing", earned: 0, possible: null });
  const parsed = positivePoints(possible);
  if (!parsed.ok) return parsed;
  return ok({ kind: "missing", earned: 0, possible: parsed.value });
}

export function latePoints(
  earned: number | null,
  possible: number | null,
): Result<LatePoints, DomainError> {
  let parsedEarned: number | null = null;
  if (earned !== null) {
    const parsed = nonNegative(earned, "earned");
    if (!parsed.ok) return parsed;
    parsedEarned = parsed.value;
  }
  let parsedPossible: number | null = null;
  if (possible !== null) {
    const parsed = positivePoints(possible);
    if (!parsed.ok) return parsed;
    parsedPossible = parsed.value;
  }
  if (parsedEarned !== null && parsedPossible !== null && parsedEarned > parsedPossible) {
    return err({ kind: "earned_exceeds_possible", earned: parsedEarned, possible: parsedPossible });
  }
  return ok({ kind: "late", earned: parsedEarned, possible: parsedPossible });
}

export function pointsEarned(
  points: UngradedPoints | GradedPoints | MissingPoints | LatePoints,
): number | null {
  switch (points.kind) {
    case "ungraded":
      return null;
    case "graded":
      return points.earned;
    case "missing":
      return 0;
    case "late":
      return points.earned;
    default:
      return unreachable(points);
  }
}

export function pointsPossible(
  points: UngradedPoints | GradedPoints | MissingPoints | LatePoints,
): number | null {
  return points.possible;
}
