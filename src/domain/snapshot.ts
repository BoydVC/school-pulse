import type { AssignmentDraft } from "./assignment.ts";
import type {
  CourseName,
  HouseholdKey,
  IsoInstant,
  PersonName,
  Source,
  SourceId,
} from "./brand.ts";
import type { GradeValue } from "./grade.ts";

export type StudentDraft = {
  readonly householdKey: HouseholdKey;
  readonly displayName: PersonName;
  readonly schoolName: PersonName | null;
  readonly source: Source;
  readonly sourceId: SourceId;
};

export type CourseDraft = {
  readonly householdKey: HouseholdKey;
  readonly name: CourseName;
  readonly teacher: PersonName | null;
  readonly period: string | null;
  readonly source: Source;
  readonly sourceId: SourceId;
};

export type GradeDraft = {
  readonly householdKey: HouseholdKey;
  readonly courseName: CourseName;
  readonly source: Source;
  readonly sourceId: SourceId;
  readonly value: GradeValue;
  readonly asOf: IsoInstant;
};

/**
 * One adapter read. Identifiers here are source identifiers and household
 * slugs. Internal ids are assigned by the store so two sources can share a
 * student and a course name without forging each other's keys.
 */
export type SchoolSnapshot = {
  readonly source: Source;
  readonly fetchedAt: IsoInstant;
  readonly students: readonly StudentDraft[];
  readonly courses: readonly CourseDraft[];
  readonly assignments: readonly AssignmentDraft[];
  readonly grades: readonly GradeDraft[];
};

export type SnapshotFormat = "html" | "json" | "csv";

export type SnapshotDocument = {
  readonly format: SnapshotFormat;
  readonly filename: string;
  readonly text: string;
  readonly now: IsoInstant;
};
