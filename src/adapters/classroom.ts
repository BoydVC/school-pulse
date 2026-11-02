import { letterForPercent } from '../dates.js';
import { AdapterError, type AssignmentStatus, type ParsedAssignment, type ParsedBatch, type ParsedGrade } from '../model.js';
import { round2 } from '../text.js';

/** Calendar date as returned by Classroom. Month is 1–12, not 0-based. */
interface GDate {
  year?: number;
  month?: number;
  day?: number;
}

interface GTime {
  hours?: number;
  minutes?: number;
  seconds?: number;
  nanos?: number;
}

interface GradeCategory {
  id?: string;
  name?: string;
  /** Basis points: 12.34% is 123400, 100% is 1_000_000. */
  weight?: number;
  defaultGradeDenominator?: number;
}

interface Course {
  id?: string;
  name?: string;
  section?: string;
  room?: string;
  ownerId?: string;
  courseState?: string;
  alternateLink?: string;
  guardiansEnabled?: boolean;
  gradebookSettings?: {
    calculationType?: 'TOTAL_POINTS' | 'WEIGHTED_CATEGORIES' | 'CALCULATION_TYPE_UNSPECIFIED' | string;
    displaySetting?: 'SHOW_OVERALL_GRADE' | 'HIDE_OVERALL_GRADE' | 'SHOW_TEACHERS_ONLY' | 'DISPLAY_SETTING_UNSPECIFIED' | string;
    gradeCategories?: GradeCategory[];
  };
}

interface CourseWork {
  courseId?: string;
  id?: string;
  title?: string;
  description?: string;
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  dueDate?: GDate;
  dueTime?: GTime;
  maxPoints?: number;
  workType?: string;
  assigneeMode?: string;
  individualStudentsOptions?: { studentIds?: string[] };
  topicId?: string;
  gradeCategory?: GradeCategory;
  gradingPeriodId?: string;
}

interface StudentSubmission {
  courseId?: string;
  courseWorkId?: string;
  id?: string;
  userId?: string;
  creationTime?: string;
  updateTime?: string;
  state?: string;
  late?: boolean;
  draftGrade?: number;
  assignedGrade?: number;
  alternateLink?: string;
  courseWorkType?: string;
}

interface GradingPeriod {
  id?: string;
  title?: string;
  startDate?: GDate;
  endDate?: GDate;
}

interface ListPage<T> {
  nextPageToken?: string;
  [key: string]: T[] | string | undefined;
}

export interface ClassroomSnapshot {
  schoolPulse?: {
    exportedAt?: string;
    school?: string;
    students?: Record<string, { name?: string; school?: string }>;
  };
  fetchedAt?: string;
  student?: { userId?: string; fullName?: string; name?: string; school?: string };
  courses?: { courses?: Course[]; nextPageToken?: string } | Course[];
  courseWork?: Record<string, ListPage<CourseWork> | ListPage<CourseWork>[] | CourseWork[]>;
  studentSubmissions?: Record<string, ListPage<StudentSubmission> | ListPage<StudentSubmission>[] | StudentSubmission[]>;
  gradingPeriodSettings?: Record<string, { gradingPeriods?: GradingPeriod[] }>;
  guardians?: { guardians?: { studentId?: string; guardianId?: string; invitedEmailAddress?: string; guardianProfile?: { name?: { fullName?: string } } }[] };
}

const ACTIVE = new Set(['ACTIVE']);
const SKIP_WORK = new Set(['DRAFT', 'DELETED', 'COURSE_WORK_STATE_UNSPECIFIED']);

/**
 * Parse courses.list, courseWork.list, and studentSubmissions.list payloads.
 * `draftGrade` is teacher-only; overall percent is computed locally because
 * the API does not return it. Excused is not a field on StudentSubmission.
 */
export function parseClassroom(input: string | ClassroomSnapshot, options?: { now?: string }): ParsedBatch {
  const snapshot: ClassroomSnapshot = typeof input === 'string' ? (JSON.parse(input) as ClassroomSnapshot) : input;
  const fetchedAt = snapshot.schoolPulse?.exportedAt ?? snapshot.fetchedAt ?? options?.now ?? new Date().toISOString();
  const now = fetchedAt;
  const student = resolveStudent(snapshot);
  if (!student.userId || !student.name) {
    throw new AdapterError('Classroom snapshot needs the student userId and name', 'google-classroom');
  }
  const courses = flattenNamed(snapshot.courses, 'courses').filter((course) => ACTIVE.has(course.courseState ?? 'ACTIVE') || course.courseState === undefined);
  const active = courses.filter((course) => course.courseState === 'ACTIVE' || course.courseState === undefined);
  const notes: string[] = [
    'Classroom StudentSubmission has no excused field. Returned work with no assignedGrade is not treated as excused (it is indistinguishable from "complete").',
  ];
  if (snapshot.guardians?.guardians?.length) {
    notes.push('userProfiles.guardians is a link list, not a grade source. Guardian profiles were ignored.');
  }

  const assignments: ParsedAssignment[] = [];
  const grades: ParsedGrade[] = [];
  const parsedCourses = [];
  const replaceGroups: string[] = [];

  for (const course of active) {
    if (!course.id || !course.name) continue;
    const categories = course.gradebookSettings?.gradeCategories ?? [];
    const periods = snapshot.gradingPeriodSettings?.[course.id]?.gradingPeriods ?? [];
    const currentPeriod = periodContaining(periods, now);
    const workPages = flattenCoursePages(snapshot.courseWork?.[course.id], 'courseWork');
    const submissionPages = flattenCoursePages(snapshot.studentSubmissions?.[course.id], 'studentSubmissions');
    const submissionsByWork = new Map<string, StudentSubmission>();
    for (const submission of submissionPages) {
      if (!submission.courseWorkId) continue;
      if (submission.userId && submission.userId !== student.userId && submission.userId !== 'me') continue;
      submissionsByWork.set(submission.courseWorkId, submission);
    }
    const courseAssignments: ParsedAssignment[] = [];
    for (const work of workPages) {
      if (!work.id || !work.title) continue;
      if (SKIP_WORK.has(work.state ?? '')) continue;
      const dropped = isDropped(work, student.userId);
      const submission = submissionsByWork.get(work.id) ?? null;
      const periodId = work.gradingPeriodId ?? '';
      const term = periodTitle(periods, periodId);
      const groupKey = `gc:${course.id}:${periodId || 'none'}`;
      if (!replaceGroups.includes(groupKey)) replaceGroups.push(groupKey);
      const category = resolveCategory(work.gradeCategory, categories);
      courseAssignments.push(
        toAssignment({
          work,
          submission,
          courseId: course.id,
          courseName: course.name,
          studentSourceId: student.userId,
          term,
          category,
          dropped,
          now,
          groupKey,
        }),
      );
    }
    const visible = course.gradebookSettings?.displaySetting ?? 'SHOW_OVERALL_GRADE';
    const hideOverall = visible === 'HIDE_OVERALL_GRADE';
    const currentAssignments = courseAssignments.filter((item) => (currentPeriod ? item.term === currentPeriod.title : true));
    const percent = hideOverall
      ? null
      : overallPercent(currentAssignments, categories, course.gradebookSettings?.calculationType ?? 'TOTAL_POINTS');
    parsedCourses.push({
      sourceId: course.id,
      studentSourceId: student.userId,
      name: course.name,
      teacher: null,
      period: course.section ?? null,
      term: currentPeriod?.title ?? null,
      url: course.alternateLink ?? null,
      categories: categories
        .filter((category) => category.name)
        .map((category) => ({
          name: category.name!,
          weight: category.weight === undefined ? 0 : weightToPercent(category.weight),
        })),
    });
    if (!hideOverall && percent !== null) {
      grades.push({
        studentSourceId: student.userId,
        courseSourceId: course.id,
        courseName: course.name,
        percent,
        letter: letterForPercent(percent),
        term: currentPeriod?.title ?? null,
        asOf: fetchedAt,
        current: true,
      });
    }
    assignments.push(...courseAssignments);
  }

  return {
    source: 'google-classroom',
    fetchedAt,
    students: [{ sourceId: student.userId, name: student.name, school: student.school }],
    courses: parsedCourses,
    assignments,
    grades,
    replaceGroups,
    notes,
  };
}

function resolveStudent(snapshot: ClassroomSnapshot): { userId: string; name: string; school: string } {
  const fromTop = snapshot.student;
  const map = snapshot.schoolPulse?.students ?? {};
  const userId = fromTop?.userId ?? Object.keys(map)[0] ?? '';
  const mapped = userId ? map[userId] : undefined;
  return {
    userId,
    name: fromTop?.fullName || fromTop?.name || mapped?.name || '',
    school: fromTop?.school || mapped?.school || snapshot.schoolPulse?.school || '',
  };
}

function flattenNamed<T>(value: { [key: string]: T[] | string | undefined } | T[] | undefined, key: string): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const items = value[key];
  return Array.isArray(items) ? items : [];
}

function flattenCoursePages<T>(value: ListPage<T> | ListPage<T>[] | T[] | undefined, key: string): T[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const first = value[0] as T | ListPage<T>;
    if (first && typeof first === 'object' && key in (first as object)) {
      return (value as ListPage<T>[]).flatMap((page) => {
        const items = page[key];
        return Array.isArray(items) ? items : [];
      });
    }
    return value as T[];
  }
  const items = value[key];
  return Array.isArray(items) ? items : [];
}

export function weightToPercent(weight: number): number {
  return round2(weight / 10000);
}

function resolveCategory(
  onWork: GradeCategory | undefined,
  courseCategories: GradeCategory[],
): { name: string | null; weight: number | null } {
  if (!onWork && courseCategories.length === 0) return { name: null, weight: null };
  const match = courseCategories.find((category) => category.id && category.id === onWork?.id) ?? onWork;
  if (!match?.name && !onWork?.name) return { name: null, weight: null };
  const weight = match?.weight ?? onWork?.weight;
  return {
    name: match?.name ?? onWork?.name ?? null,
    weight: weight === undefined ? null : weightToPercent(weight),
  };
}

function isDropped(work: CourseWork, userId: string): boolean {
  if (work.assigneeMode !== 'INDIVIDUAL_STUDENTS') return false;
  const ids = work.individualStudentsOptions?.studentIds ?? [];
  return !ids.includes(userId);
}

function calendarDate(date: GDate | undefined): string | null {
  if (!date?.year || !date.month || !date.day) return null;
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function periodContaining(periods: GradingPeriod[], nowIso: string): GradingPeriod | null {
  const today = nowIso.slice(0, 10);
  const dated = periods.filter((period) => calendarDate(period.startDate) && calendarDate(period.endDate));
  const match = dated.find((period) => {
    const start = calendarDate(period.startDate)!;
    const end = calendarDate(period.endDate)!;
    return today >= start && today <= end;
  });
  if (match) return match;
  const sorted = [...dated].sort((a, b) => (calendarDate(a.endDate)! < calendarDate(b.endDate)! ? 1 : -1));
  return sorted[0] ?? periods[0] ?? null;
}

function periodTitle(periods: GradingPeriod[], id: string): string | null {
  if (!id) return null;
  return periods.find((period) => period.id === id)?.title ?? id;
}

function toAssignment(input: {
  work: CourseWork;
  submission: StudentSubmission | null;
  courseId: string;
  courseName: string;
  studentSourceId: string;
  term: string | null;
  category: { name: string | null; weight: number | null };
  dropped: boolean;
  now: string;
  groupKey: string;
}): ParsedAssignment {
  const due = calendarDate(input.work.dueDate);
  const maxPoints = input.work.maxPoints;
  const pointsPossible = maxPoints === undefined || maxPoints === 0 ? null : maxPoints;
  const state = input.submission?.state ?? 'CREATED';
  const late = input.submission?.late === true;
  const turnedIn = state === 'TURNED_IN' || state === 'RETURNED' || state === 'STUDENT_EDITED_AFTER_TURN_IN';
  const pastDue = due !== null && due < input.now.slice(0, 10);
  let status: AssignmentStatus;
  if (turnedIn && late) status = 'late';
  else if (turnedIn && input.submission?.assignedGrade !== undefined && state === 'RETURNED') status = 'graded';
  else if (turnedIn) status = 'turned_in';
  else if (!input.dropped && pastDue && (state === 'NEW' || state === 'CREATED' || state === 'RECLAIMED_BY_STUDENT')) status = 'missing';
  else status = 'assigned';

  let pointsEarned: number | null = null;
  if (input.submission?.assignedGrade !== undefined && (status === 'graded' || status === 'late')) {
    pointsEarned = input.submission.assignedGrade;
  } else if (status === 'missing') {
    pointsEarned = input.submission?.draftGrade ?? 0;
  }

  return {
    sourceId: `gc:${input.courseId}:${input.work.id}`,
    studentSourceId: input.studentSourceId,
    courseSourceId: input.courseId,
    title: input.work.title ?? 'Course work',
    courseName: input.courseName,
    due,
    assigned: input.work.creationTime ? input.work.creationTime.slice(0, 10) : null,
    status,
    pointsEarned: pointsPossible === null ? null : pointsEarned,
    pointsPossible,
    category: input.category.name,
    categoryWeight: input.category.weight,
    url: input.submission?.alternateLink ?? input.work.alternateLink ?? null,
    term: input.term,
    dropped: input.dropped,
    groupKey: input.groupKey,
  };
}

/**
 * Mirror Classroom's overall grade. Weighted categories renormalize when a
 * category has no graded work. Missing work counts as its draftGrade (default 0).
 * Ungraded (maxPoints 0), excused-indistinguishable ungraded returns, and dropped
 * rows are left out.
 */
export function overallPercent(
  assignments: Pick<ParsedAssignment, 'status' | 'pointsEarned' | 'pointsPossible' | 'category' | 'dropped'>[],
  categories: GradeCategory[],
  calculationType: string,
): number | null {
  const counted = assignments.filter(
    (item) => !item.dropped && item.pointsPossible !== null && item.pointsPossible > 0 && item.pointsEarned !== null && item.status !== 'excused',
  );
  if (counted.length === 0) return null;
  if (calculationType === 'WEIGHTED_CATEGORIES' && categories.some((category) => category.weight !== undefined)) {
    const groups = new Map<string, { earned: number; possible: number; weight: number }>();
    for (const category of categories) {
      if (!category.name || category.weight === undefined) continue;
      groups.set(category.name, { earned: 0, possible: 0, weight: weightToPercent(category.weight) });
    }
    for (const item of counted) {
      const bucket = item.category ? groups.get(item.category) : undefined;
      if (!bucket) continue;
      bucket.earned += item.pointsEarned ?? 0;
      bucket.possible += item.pointsPossible ?? 0;
    }
    const present = [...groups.values()].filter((bucket) => bucket.possible > 0);
    const weightSum = present.reduce((total, bucket) => total + bucket.weight, 0);
    if (weightSum <= 0) return null;
    const total = present.reduce((sum, bucket) => sum + (bucket.earned / bucket.possible) * (bucket.weight / weightSum), 0);
    return round2(total * 100);
  }
  const earned = counted.reduce((total, item) => total + (item.pointsEarned ?? 0), 0);
  const possible = counted.reduce((total, item) => total + (item.pointsPossible ?? 0), 0);
  if (possible <= 0) return null;
  return round2((earned / possible) * 100);
}

/** UTC instant for a Classroom dueDate + dueTime. Hours default to 0 when omitted. */
export function classroomDueInstant(date: GDate | undefined, time: GTime | undefined): string | null {
  const day = calendarDate(date);
  if (!day) return null;
  if (!time) return day;
  const hours = time.hours ?? 0;
  const minutes = time.minutes ?? 0;
  const seconds = time.seconds ?? 0;
  return `${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}Z`;
}
