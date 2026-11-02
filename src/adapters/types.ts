import type { AssignmentStatus } from "../model/types.js";

export interface NormalizedStudent {
  sourceId: string;
  name: string;
  school: string | null;
  gradeLevel: string | null;
}

export interface NormalizedCourse {
  sourceId: string;
  studentSourceId: string;
  name: string;
  teacher: string | null;
  period: string | null;
}

export interface NormalizedAssignment {
  sourceId: string;
  studentSourceId: string;
  courseSourceId: string;
  title: string;
  due: string | null;
  assigned: string | null;
  status: AssignmentStatus;
  pointsEarned: number | null;
  pointsPossible: number | null;
  category: string | null;
  url: string | null;
  groupKey: string | null;
}

export interface NormalizedGrade {
  studentSourceId: string;
  courseSourceId: string;
  percent: number | null;
  letter: string | null;
  asOf: string;
}

export interface NormalizedSnapshot {
  source: string;
  fetchedAt: string;
  students: NormalizedStudent[];
  courses: NormalizedCourse[];
  assignments: NormalizedAssignment[];
  grades: NormalizedGrade[];
  /** Complete lists. Assignments in these groups that vanish from a later snapshot are marked removed. */
  replaceGroups: string[];
  notes: string[];
}

export function emptySnapshot(source: string, fetchedAt: string): NormalizedSnapshot {
  return { source, fetchedAt, students: [], courses: [], assignments: [], grades: [], replaceGroups: [], notes: [] };
}
