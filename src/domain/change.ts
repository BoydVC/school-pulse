import { statusLabel } from "./assignment.ts";
import {
  courseName,
  instant,
  isSource,
  parseStatus,
  title,
  type AssignmentId,
  type AssignmentStatus,
  type ChangeId,
  type CourseId,
  type CourseName,
  type IsoInstant,
  type Source,
  type StudentId,
  type Title,
} from "./brand.ts";
import { formatGradeNumber, gradeValue, type GradeValue } from "./grade.ts";
import { unreachable } from "./result.ts";
import { weekdayShort } from "./when.ts";

export type GradeChange = {
  readonly kind: "grade";
  readonly id: ChangeId;
  readonly studentId: StudentId;
  readonly courseId: CourseId;
  readonly courseName: CourseName;
  readonly source: Source;
  readonly from: GradeValue;
  readonly to: GradeValue;
  readonly at: IsoInstant;
};

export type NewAssignmentChange = {
  readonly kind: "assignment_new";
  readonly id: ChangeId;
  readonly studentId: StudentId;
  readonly courseId: CourseId;
  readonly courseName: CourseName;
  readonly assignmentId: AssignmentId;
  readonly title: Title;
  readonly dueAt: IsoInstant | null;
  readonly source: Source;
  readonly at: IsoInstant;
};

export type StatusChange = {
  readonly kind: "assignment_status";
  readonly id: ChangeId;
  readonly studentId: StudentId;
  readonly courseId: CourseId;
  readonly courseName: CourseName;
  readonly assignmentId: AssignmentId;
  readonly title: Title;
  readonly from: AssignmentStatus;
  readonly to: AssignmentStatus;
  readonly source: Source;
  readonly at: IsoInstant;
};

export type ScoreChange = {
  readonly kind: "assignment_score";
  readonly id: ChangeId;
  readonly studentId: StudentId;
  readonly courseId: CourseId;
  readonly courseName: CourseName;
  readonly assignmentId: AssignmentId;
  readonly title: Title;
  readonly fromEarned: number | null;
  readonly toEarned: number | null;
  readonly possible: number | null;
  readonly source: Source;
  readonly at: IsoInstant;
};

export type Change = GradeChange | NewAssignmentChange | StatusChange | ScoreChange;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`change is missing ${field}`);
  return value;
}

export function parseChange(payload: string): Change {
  const value: unknown = JSON.parse(payload);
  if (!record(value)) throw new Error("change payload is not an object");
  const kind = requiredString(value["kind"], "kind");
  const sourceText = requiredString(value["source"], "source");
  if (!isSource(sourceText)) throw new Error(`change source ${sourceText}`);
  const parsedCourse = courseName(requiredString(value["courseName"], "courseName"));
  if (!parsedCourse.ok) throw new Error("change course name");
  const at = instant(requiredString(value["at"], "at"));
  if (!at.ok) throw new Error("change timestamp");
  const base = {
    id: requiredString(value["id"], "id") as ChangeId,
    studentId: requiredString(value["studentId"], "studentId") as StudentId,
    courseId: requiredString(value["courseId"], "courseId") as CourseId,
    courseName: parsedCourse.value,
    source: sourceText,
    at: at.value,
  };
  if (kind === "grade") {
    const fromRecord = value["from"];
    const toRecord = value["to"];
    if (!record(fromRecord) || !record(toRecord)) throw new Error("grade change bounds");
    const from = gradeValue(
      typeof fromRecord["percent"] === "number" ? fromRecord["percent"] : null,
      typeof fromRecord["letter"] === "string" ? fromRecord["letter"] : null,
    );
    const to = gradeValue(
      typeof toRecord["percent"] === "number" ? toRecord["percent"] : null,
      typeof toRecord["letter"] === "string" ? toRecord["letter"] : null,
    );
    if (!from.ok || !to.ok) throw new Error("grade change values");
    return { ...base, kind, from: from.value, to: to.value };
  }
  const assignmentId = requiredString(value["assignmentId"], "assignmentId") as AssignmentId;
  const parsedTitle = title(requiredString(value["title"], "title"));
  if (!parsedTitle.ok) throw new Error("change title");
  if (kind === "assignment_new") {
    const dueRaw = value["dueAt"];
    const dueAt = dueRaw === null ? null : instant(requiredString(dueRaw, "dueAt"));
    if (dueAt && !dueAt.ok) throw new Error("change due date");
    return { ...base, kind, assignmentId, title: parsedTitle.value, dueAt: dueAt === null ? null : dueAt.value };
  }
  if (kind === "assignment_status") {
    const from = parseStatus(requiredString(value["from"], "from"));
    const to = parseStatus(requiredString(value["to"], "to"));
    if (!from.ok || !to.ok) throw new Error("change status");
    return { ...base, kind, assignmentId, title: parsedTitle.value, from: from.value, to: to.value };
  }
  if (kind === "assignment_score") {
    const fromEarned = value["fromEarned"];
    const toEarned = value["toEarned"];
    const possible = value["possible"];
    if (fromEarned !== null && typeof fromEarned !== "number") throw new Error("change fromEarned");
    if (toEarned !== null && typeof toEarned !== "number") throw new Error("change toEarned");
    if (possible !== null && typeof possible !== "number") throw new Error("change possible");
    return {
      ...base,
      kind,
      assignmentId,
      title: parsedTitle.value,
      fromEarned,
      toEarned,
      possible,
    };
  }
  throw new Error(`unknown change kind ${kind}`);
}

export function describeChange(change: Change): string {
  switch (change.kind) {
    case "grade": {
      const from = formatGradeNumber(change.from);
      const to = formatGradeNumber(change.to);
      if (from === to && change.from.letter && change.to.letter && change.from.letter !== change.to.letter) {
        return `${change.courseName} went from ${change.from.letter} to ${change.to.letter}`;
      }
      return `${change.courseName} went from ${from} to ${to}`;
    }
    case "assignment_new": {
      const due = weekdayShort(change.dueAt);
      return due ? `New: ${change.title} due ${due}` : `New: ${change.title}`;
    }
    case "assignment_status":
      return `${change.title} is now ${statusLabel(change.to)}`;
    case "assignment_score": {
      const from = change.fromEarned === null ? "ungraded" : String(change.fromEarned);
      const to = change.toEarned === null ? "ungraded" : String(change.toEarned);
      const possible = change.possible === null ? "" : `/${change.possible}`;
      return `${change.title} score went from ${from}${possible} to ${to}${possible}`;
    }
    default:
      return unreachable(change);
  }
}
