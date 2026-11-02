export type AssignmentStatus =
  | "assigned"
  | "turned_in"
  | "graded"
  | "missing"
  | "late"
  | "excused";

export const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  "assigned",
  "turned_in",
  "graded",
  "missing",
  "late",
  "excused",
];

export type ChangeKind =
  | "grade"
  | "assignment_new"
  | "assignment_status"
  | "assignment_score"
  | "assignment_due"
  | "assignment_moved";

export interface Student {
  id: string;
  source: string;
  sourceId: string;
  name: string;
  school: string | null;
  gradeLevel: string | null;
  fetchedAt: string;
}

export interface Course {
  id: string;
  studentId: string;
  source: string;
  sourceId: string;
  name: string;
  teacher: string | null;
  period: string | null;
  fetchedAt: string;
}

export interface Assignment {
  id: string;
  studentId: string;
  courseId: string;
  title: string;
  due: string | null;
  assigned: string | null;
  status: AssignmentStatus;
  pointsEarned: number | null;
  pointsPossible: number | null;
  category: string | null;
  url: string | null;
  source: string;
  sourceId: string;
  lastSeen: string;
  fetchedAt: string;
}

export interface GradeSnapshot {
  id: string;
  studentId: string;
  courseId: string;
  percent: number | null;
  letter: string | null;
  asOf: string;
  source: string;
  fetchedAt: string;
}

export interface Change {
  id: string;
  studentId: string | null;
  courseId: string | null;
  assignmentId: string | null;
  kind: ChangeKind;
  summary: string;
  before: string | null;
  after: string | null;
  source: string;
  fetchedAt: string;
  createdAt: string;
}

export type AlertRuleType = "grade_below" | "missing_above" | "grade_drop";

export interface AlertRule {
  id: string;
  enabled: boolean;
  type: AlertRuleType;
  threshold: number;
  studentName: string | null;
  createdAt: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  summary: string;
  dedupeKey: string;
  createdAt: string;
  source: string;
}

export function isAssignmentStatus(value: string): value is AssignmentStatus {
  return (ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}
