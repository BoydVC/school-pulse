import {
  assignmentDraft,
  courseName,
  err,
  explain,
  gradeValue,
  householdKey,
  httpUrl,
  instant,
  ok,
  personName,
  sourceId,
  type AssignmentDraft,
  type CourseDraft,
  type CourseName,
  type DomainError,
  type GradeDraft,
  type GradeValue,
  type HouseholdKey,
  type IsoInstant,
  type PersonName,
  type Result,
  type SchoolSnapshot,
  type Source,
  type SourceId,
  type StudentDraft,
} from "../domain/index.ts";
import type { AdapterFailure } from "./adapter.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(source: Source, path: string, error: DomainError): Result<never, AdapterFailure> {
  return err({ kind: "invalid", source, path, message: explain(error) });
}

export function parseError(source: Source, message: string): Result<never, AdapterFailure> {
  return err({ kind: "parse", source, message });
}

export function unsupported(source: Source, format: string): Result<never, AdapterFailure> {
  return err({ kind: "unsupported_format", source, format });
}

export function readJson(text: string, source: Source): Result<unknown, AdapterFailure> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    return parseError(source, message);
  }
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null | "bad" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : "bad";
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return "bad";
}

export function snapshot(source: Source, fetchedAt: IsoInstant, parts: {
  readonly students: readonly StudentDraft[];
  readonly courses: readonly CourseDraft[];
  readonly assignments: readonly AssignmentDraft[];
  readonly grades: readonly GradeDraft[];
}): SchoolSnapshot {
  return { source, fetchedAt, ...parts };
}

export function buildFetchedAt(
  raw: unknown,
  now: IsoInstant,
  source: Source,
): Result<IsoInstant, AdapterFailure> {
  if (raw === undefined || raw === null || raw === "") return ok(now);
  if (typeof raw !== "string") return parseError(source, "fetchedAt must be a string");
  const parsed = instant(raw);
  if (!parsed.ok) return fail(source, "fetchedAt", parsed.error);
  return ok(parsed.value);
}

export function buildStudent(
  source: Source,
  path: string,
  input: { sourceId: string; householdKey: string; displayName: string; schoolName: string | null },
): Result<StudentDraft, AdapterFailure> {
  const parsedId = sourceId(input.sourceId);
  if (!parsedId.ok) return fail(source, `${path}.sourceId`, parsedId.error);
  const parsedKey = householdKey(input.householdKey);
  if (!parsedKey.ok) return fail(source, `${path}.householdKey`, parsedKey.error);
  const parsedName = personName(input.displayName, "displayName");
  if (!parsedName.ok) return fail(source, `${path}.displayName`, parsedName.error);
  const school = input.schoolName === null ? ok(null) : personName(input.schoolName, "schoolName");
  if (!school.ok) return fail(source, `${path}.schoolName`, school.error);
  return ok({
    source,
    sourceId: parsedId.value,
    householdKey: parsedKey.value,
    displayName: parsedName.value,
    schoolName: school.value,
  });
}

export function buildCourse(
  source: Source,
  path: string,
  input: {
    sourceId: string;
    householdKey: HouseholdKey;
    name: string;
    teacher: string | null;
    period: string | null;
  },
): Result<CourseDraft, AdapterFailure> {
  const parsedId = sourceId(input.sourceId);
  if (!parsedId.ok) return fail(source, `${path}.sourceId`, parsedId.error);
  const parsedName = courseName(input.name);
  if (!parsedName.ok) return fail(source, `${path}.name`, parsedName.error);
  const teacher = input.teacher === null ? ok(null) : personName(input.teacher, "teacher");
  if (!teacher.ok) return fail(source, `${path}.teacher`, teacher.error);
  const period = input.period?.trim() ?? "";
  if (period.length > 20) return parseError(source, `${path}.period is too long`);
  return ok({
    source,
    sourceId: parsedId.value,
    householdKey: input.householdKey,
    name: parsedName.value,
    teacher: teacher.value,
    period: period.length > 0 ? period : null,
  });
}

export function buildGrade(
  source: Source,
  path: string,
  input: {
    sourceId: string;
    householdKey: HouseholdKey;
    courseName: string;
    percent: number | null;
    letter: string | null;
    asOf: string;
  },
): Result<GradeDraft, AdapterFailure> {
  const parsedId = sourceId(input.sourceId);
  if (!parsedId.ok) return fail(source, `${path}.sourceId`, parsedId.error);
  const parsedCourse = courseName(input.courseName);
  if (!parsedCourse.ok) return fail(source, `${path}.course`, parsedCourse.error);
  const value = gradeValue(input.percent, input.letter);
  if (!value.ok) return fail(source, path, value.error);
  const asOf = instant(input.asOf);
  if (!asOf.ok) return fail(source, `${path}.asOf`, asOf.error);
  return ok({
    source,
    sourceId: parsedId.value,
    householdKey: input.householdKey,
    courseName: parsedCourse.value,
    value: value.value,
    asOf: asOf.value,
  });
}

export function buildAssignment(
  source: Source,
  path: string,
  input: {
    sourceId: string;
    householdKey: string;
    courseName: string;
    title: string;
    status: string;
    earned: number | null;
    possible: number | null;
    assignedAt: string | null;
    dueAt: string | null;
    category: string | null;
    url: string | null;
  },
): Result<AssignmentDraft, AdapterFailure> {
  const draft = assignmentDraft({ source, ...input });
  if (!draft.ok) return fail(source, path, draft.error);
  return ok(draft.value);
}

export function requireString(value: unknown, source: Source, path: string): Result<string, AdapterFailure> {
  const text = asString(value);
  if (text === null) return parseError(source, `${path} is required`);
  return ok(text);
}

export type { GradeValue, HouseholdKey, PersonName, SourceId };
