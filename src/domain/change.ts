import type { AssignmentStatus } from "./brand.ts";
import type {
  AssignmentId,
  ChangeId,
  CourseId,
  CourseName,
  IsoInstant,
  Source,
  StudentId,
  Title,
} from "./brand.ts";
import { formatGradeNumber, type GradeValue } from "./grade.ts";
import { unreachable } from "./result.ts";
import { statusLabel } from "./assignment.ts";
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

export function describeChange(change: Change): string {
  switch (change.kind) {
    case "grade":
      return `${change.courseName} went from ${formatGradeNumber(change.from)} to ${formatGradeNumber(change.to)}`;
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
