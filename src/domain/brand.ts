import { err, ok, unreachable, type Result } from "./result.js";

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type HouseholdKey = Brand<string, "HouseholdKey">;
export type SourceId = Brand<string, "SourceId">;
export type StudentId = Brand<string, "StudentId">;
export type CourseId = Brand<string, "CourseId">;
export type AssignmentId = Brand<string, "AssignmentId">;
export type GradeSnapshotId = Brand<string, "GradeSnapshotId">;
export type ChangeId = Brand<string, "ChangeId">;
export type Percent = Brand<number, "Percent">;
export type IsoInstant = Brand<string, "IsoInstant">;
export type CourseName = Brand<string, "CourseName">;
export type PersonName = Brand<string, "PersonName">;
export type Title = Brand<string, "Title">;
export type HttpUrl = Brand<string, "HttpUrl">;

export const SOURCES = ["powerschool", "onenote", "google-classroom", "generic"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<Source, string> = {
  powerschool: "PowerSchool",
  onenote: "OneNote",
  "google-classroom": "Google Classroom",
  generic: "Generic",
};

export const ASSIGNMENT_STATUSES = [
  "assigned",
  "turned_in",
  "graded",
  "missing",
  "late",
  "excused",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const LETTER_GRADES = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D+",
  "D",
  "D-",
  "F",
] as const;
export type LetterGrade = (typeof LETTER_GRADES)[number];

export type DomainError =
  | { readonly kind: "bad_household_key"; readonly value: string }
  | { readonly kind: "bad_source_id"; readonly value: string }
  | { readonly kind: "bad_source"; readonly value: string }
  | { readonly kind: "bad_instant"; readonly value: string }
  | { readonly kind: "bad_percent"; readonly value: number }
  | { readonly kind: "bad_letter"; readonly value: string }
  | { readonly kind: "empty_grade" }
  | { readonly kind: "bad_points"; readonly field: "earned" | "possible"; readonly value: number }
  | { readonly kind: "earned_exceeds_possible"; readonly earned: number; readonly possible: number }
  | { readonly kind: "graded_requires_points" }
  | { readonly kind: "missing_requires_zero" }
  | { readonly kind: "bad_status"; readonly value: string }
  | { readonly kind: "bad_title"; readonly value: string }
  | { readonly kind: "bad_name"; readonly field: string; readonly value: string }
  | { readonly kind: "bad_url"; readonly value: string }
  | { readonly kind: "bad_due"; readonly value: string };

const HOUSEHOLD = /^[a-z][a-z0-9-]{0,63}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:!~-]{0,400}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PERSON = /^[\p{L}\p{N}][\p{L}\p{N} .'+-]{0,79}$/u;
const COURSE = /^[\p{L}\p{N}][\p{L}\p{N} .'+-]{0,79}$/u;
const CONTROL = /\p{Cc}/u;

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

export function parseSource(value: string): Result<Source, DomainError> {
  if (isSource(value)) return ok(value);
  return err({ kind: "bad_source", value });
}

export function householdKey(raw: string): Result<HouseholdKey, DomainError> {
  const value = raw.trim().toLowerCase();
  if (raw.includes("@") || !HOUSEHOLD.test(value)) {
    return err({ kind: "bad_household_key", value: raw });
  }
  return ok(value as HouseholdKey);
}

export function sourceId(raw: string): Result<SourceId, DomainError> {
  const value = raw.trim();
  if (value.includes("@") || !SOURCE_ID.test(value)) {
    return err({ kind: "bad_source_id", value: raw });
  }
  return ok(value as SourceId);
}

export function percent(value: number): Result<Percent, DomainError> {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return err({ kind: "bad_percent", value });
  }
  return ok(value as Percent);
}

export function letterGrade(raw: string): Result<LetterGrade, DomainError> {
  const value = raw.trim().toUpperCase();
  if ((LETTER_GRADES as readonly string[]).includes(value)) {
    return ok(value as LetterGrade);
  }
  return err({ kind: "bad_letter", value: raw });
}

export function instant(raw: string): Result<IsoInstant, DomainError> {
  if (!INSTANT.test(raw) || Number.isNaN(Date.parse(raw))) {
    return err({ kind: "bad_instant", value: raw });
  }
  return ok(raw as IsoInstant);
}

export function instantFromDate(date: Date): IsoInstant {
  return date.toISOString() as IsoInstant;
}

export function personName(raw: string, field: string): Result<PersonName, DomainError> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.includes("@") || /[\r\n]/.test(value) || !PERSON.test(value)) {
    return err({ kind: "bad_name", field, value: raw });
  }
  return ok(value as PersonName);
}

export function courseName(raw: string): Result<CourseName, DomainError> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.includes("@") || !COURSE.test(value)) {
    return err({ kind: "bad_name", field: "course", value: raw });
  }
  return ok(value as CourseName);
}

export function title(raw: string): Result<Title, DomainError> {
  if (/^\s/u.test(raw) || CONTROL.test(raw) || raw.includes("@")) {
    return err({ kind: "bad_title", value: raw });
  }
  const value = raw.replace(/ {2,}/g, " ").trimEnd();
  if (value.length < 1 || value.length > 160) {
    return err({ kind: "bad_title", value: raw });
  }
  return ok(value as Title);
}

export function httpUrl(raw: string | null): Result<HttpUrl | null, DomainError> {
  if (raw === null || raw.trim() === "") return ok(null);
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return err({ kind: "bad_url", value: raw });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return err({ kind: "bad_url", value: raw });
  }
  return ok(parsed.toString() as HttpUrl);
}

export function parseStatus(raw: string): Result<AssignmentStatus, DomainError> {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const mapped =
    value === "exempt" ? "excused" : value === "collected" || value === "submitted" ? "turned_in" : value;
  if ((ASSIGNMENT_STATUSES as readonly string[]).includes(mapped)) {
    return ok(mapped as AssignmentStatus);
  }
  return err({ kind: "bad_status", value: raw });
}

export function studentIdFor(key: HouseholdKey): StudentId {
  return `stu_${key}` as StudentId;
}

export function courseKey(name: CourseName): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function courseIdFor(student: StudentId, name: CourseName): CourseId {
  return `crs_${student}_${courseKey(name)}` as CourseId;
}

export function assignmentIdFor(source: Source, id: SourceId): AssignmentId {
  return `asg_${source}_${id}` as AssignmentId;
}

export function gradeSnapshotIdFor(source: Source, id: SourceId, asOf: IsoInstant): GradeSnapshotId {
  return `grd_${source}_${id}_${asOf}` as GradeSnapshotId;
}

export function explain(error: DomainError): string {
  switch (error.kind) {
    case "bad_household_key":
      return `household key "${error.value}" is not a lowercase slug`;
    case "bad_source_id":
      return `source id "${error.value}" is empty, an email, or has unsupported characters`;
    case "bad_source":
      return `unknown source "${error.value}"`;
    case "bad_instant":
      return `timestamp "${error.value}" is not an ISO-8601 UTC instant`;
    case "bad_percent":
      return `percent ${error.value} is outside 0..100`;
    case "bad_letter":
      return `letter grade "${error.value}" is not on the A+..F scale`;
    case "empty_grade":
      return "a grade needs a percent, a letter, or both";
    case "bad_points":
      return `${error.field} ${error.value} is not a positive point value`;
    case "earned_exceeds_possible":
      return `earned ${error.earned} exceeds possible ${error.possible}`;
    case "graded_requires_points":
      return "graded work needs earned and possible points";
    case "missing_requires_zero":
      return "missing work cannot already have earned points";
    case "bad_status":
      return `status "${error.value}" is not assigned, turned in, graded, missing, late, or excused`;
    case "bad_title":
      return `title "${error.value}" is empty or unsupported`;
    case "bad_name":
      return `${error.field} "${error.value}" is empty, an email, or unsupported`;
    case "bad_url":
      return `url "${error.value}" must be http(s)`;
    case "bad_due":
      return `due date "${error.value}" could not be parsed`;
    default:
      return unreachable(error);
  }
}
