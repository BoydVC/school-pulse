/** Household model. Every persisted record also carries source and fetchedAt. */

export const SOURCES = ['powerschool', 'onenote', 'google-classroom', 'generic'] as const;
export type Source = (typeof SOURCES)[number];

export const ASSIGNMENT_STATUSES = [
  'assigned',
  'turned_in',
  'graded',
  'missing',
  'late',
  'excused',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const SOURCE_LABEL: Record<Source, string> = {
  powerschool: 'PowerSchool',
  onenote: 'OneNote',
  'google-classroom': 'Classroom',
  generic: 'Generic',
};

export interface CategoryWeight {
  /** Display name as it appears in the source gradebook. */
  name: string;
  /** Share of the overall grade, 0–100. */
  weight: number;
}

export interface ParsedStudent {
  sourceId: string;
  name: string;
  school: string;
}

export interface ParsedCourse {
  sourceId: string;
  studentSourceId: string;
  name: string;
  teacher: string | null;
  period: string | null;
  /** Current reporting term for this course, when the source has one (Q1, Q2, …). */
  term: string | null;
  url: string | null;
  categories: CategoryWeight[];
}

export interface ParsedAssignment {
  sourceId: string;
  studentSourceId: string;
  courseSourceId: string;
  title: string;
  courseName: string;
  /** Calendar date YYYY-MM-DD, or null when the source has no due date. */
  due: string | null;
  assigned: string | null;
  status: AssignmentStatus;
  pointsEarned: number | null;
  pointsPossible: number | null;
  category: string | null;
  categoryWeight: number | null;
  url: string | null;
  term: string | null;
  /** Excluded from the grade (PowerSchool "Excluded", Classroom not-assigned). */
  dropped: boolean;
  /** Complete-list key. Assignments in this key missing from a newer snapshot are dropped. */
  groupKey: string;
}

export interface ParsedGrade {
  studentSourceId: string;
  courseSourceId: string;
  courseName: string;
  percent: number | null;
  letter: string | null;
  term: string | null;
  /** When this grade was true, ISO-8601. */
  asOf: string;
  /** The grade the portal was showing as current at asOf. */
  current: boolean;
}

export interface ParsedBatch {
  source: Source;
  fetchedAt: string;
  students: ParsedStudent[];
  courses: ParsedCourse[];
  assignments: ParsedAssignment[];
  grades: ParsedGrade[];
  replaceGroups: string[];
  /** Fidelity notes a parser wants the caller to see (not persisted as changes). */
  notes: string[];
}

export class AdapterError extends Error {
  readonly source: Source | 'unknown';
  constructor(message: string, source: Source | 'unknown' = 'unknown') {
    super(message);
    this.name = 'AdapterError';
    this.source = source;
  }
}

export function isAssignmentStatus(value: string): value is AssignmentStatus {
  return (ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
