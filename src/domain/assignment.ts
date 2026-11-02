import {
  courseName,
  householdKey,
  httpUrl,
  instant,
  parseStatus,
  personName,
  sourceId,
  title,
  type AssignmentStatus,
  type CourseName,
  type HouseholdKey,
  type HttpUrl,
  type IsoInstant,
  type PersonName,
  type Source,
  type SourceId,
  type Title,
} from "./brand.ts";
import type { DomainError } from "./brand.ts";
import { gradedPoints, latePoints, missingPoints, pointsEarned, pointsPossible, ungradedPoints } from "./grade.ts";
import type { GradedPoints, LatePoints, MissingPoints, UngradedPoints } from "./grade.ts";
import { err, ok, type Result } from "./result.ts";

type AssignmentCommon = {
  readonly source: Source;
  readonly sourceId: SourceId;
  readonly householdKey: HouseholdKey;
  readonly courseName: CourseName;
  readonly title: Title;
  readonly assignedAt: IsoInstant | null;
  readonly dueAt: IsoInstant | null;
  readonly category: string | null;
  readonly url: HttpUrl | null;
};

export type AssignmentDraft =
  | (AssignmentCommon & { readonly status: "assigned"; readonly points: UngradedPoints })
  | (AssignmentCommon & { readonly status: "turned_in"; readonly points: UngradedPoints })
  | (AssignmentCommon & { readonly status: "graded"; readonly points: GradedPoints })
  | (AssignmentCommon & { readonly status: "missing"; readonly points: MissingPoints })
  | (AssignmentCommon & { readonly status: "late"; readonly points: LatePoints })
  | (AssignmentCommon & { readonly status: "excused"; readonly points: UngradedPoints });

export type AssignmentInput = {
  readonly source: Source;
  readonly sourceId: string;
  readonly householdKey: string;
  readonly courseName: string;
  readonly title: string;
  readonly status: string;
  readonly earned: number | null;
  readonly possible: number | null;
  readonly assignedAt: string | null;
  readonly dueAt: string | null;
  readonly category: string | null;
  readonly url: string | null;
};

function cleanCategory(raw: string | null): Result<string | null, DomainError> {
  if (raw === null || raw.trim() === "") return ok(null);
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.includes("@") || value.length > 40) return err({ kind: "bad_name", field: "category", value: raw });
  return ok(value);
}

export function assignmentDraft(input: AssignmentInput): Result<AssignmentDraft, DomainError> {
  const parsedSourceId = sourceId(input.sourceId);
  if (!parsedSourceId.ok) return parsedSourceId;
  const parsedKey = householdKey(input.householdKey);
  if (!parsedKey.ok) return parsedKey;
  const parsedCourse = courseName(input.courseName);
  if (!parsedCourse.ok) return parsedCourse;
  const parsedTitle = title(input.title);
  if (!parsedTitle.ok) return parsedTitle;
  const parsedStatus = parseStatus(input.status);
  if (!parsedStatus.ok) return parsedStatus;
  const parsedUrl = httpUrl(input.url);
  if (!parsedUrl.ok) return parsedUrl;
  const parsedCategory = cleanCategory(input.category);
  if (!parsedCategory.ok) return parsedCategory;
  const parsedAssigned = input.assignedAt === null ? ok(null) : instant(input.assignedAt);
  if (!parsedAssigned.ok) return parsedAssigned;
  const parsedDue = input.dueAt === null ? ok(null) : instant(input.dueAt);
  if (!parsedDue.ok) return parsedDue;

  const common = {
    source: input.source,
    sourceId: parsedSourceId.value,
    householdKey: parsedKey.value,
    courseName: parsedCourse.value,
    title: parsedTitle.value,
    assignedAt: parsedAssigned.value,
    dueAt: parsedDue.value,
    category: parsedCategory.value,
    url: parsedUrl.value,
  };

  const status = parsedStatus.value;
  if (status === "graded") {
    if (input.earned === null || input.possible === null) return err({ kind: "graded_requires_points" });
    const points = gradedPoints(input.earned, input.possible);
    if (!points.ok) return points;
    return ok({ ...common, status, points: points.value });
  }
  if (status === "missing") {
    if (input.earned !== null && input.earned !== 0) return err({ kind: "missing_requires_zero" });
    const points = missingPoints(input.possible);
    if (!points.ok) return points;
    return ok({ ...common, status, points: points.value });
  }
  if (status === "late") {
    const points = latePoints(input.earned, input.possible);
    if (!points.ok) return points;
    return ok({ ...common, status, points: points.value });
  }
  if (input.earned !== null) return err({ kind: "bad_points", field: "earned", value: input.earned });
  const points = ungradedPoints(input.possible);
  if (!points.ok) return points;
  return ok({ ...common, status, points: points.value });
}

export function assignmentCanonical(draft: AssignmentDraft): string {
  return JSON.stringify([
    draft.source,
    draft.sourceId,
    draft.householdKey,
    draft.courseName,
    draft.title,
    draft.status,
    pointsEarned(draft.points),
    pointsPossible(draft.points),
    draft.assignedAt,
    draft.dueAt,
    draft.category,
    draft.url,
  ]);
}

export function statusLabel(status: AssignmentStatus): string {
  switch (status) {
    case "assigned":
      return "assigned";
    case "turned_in":
      return "turned in";
    case "graded":
      return "graded";
    case "missing":
      return "missing";
    case "late":
      return "late";
    case "excused":
      return "excused";
  }
}
