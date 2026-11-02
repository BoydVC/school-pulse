import { isAssignmentStatus, AdapterError, type ParsedAssignment, type ParsedBatch, type ParsedGrade, type AssignmentStatus } from '../model.js';
import { parseLooseDate } from '../dates.js';
import { collapse, slug } from '../text.js';

interface GenericFile {
  source?: string;
  fetchedAt?: string;
  students?: { sourceId?: string; name?: string; school?: string }[];
  courses?: {
    sourceId?: string;
    student?: string;
    studentSourceId?: string;
    name?: string;
    teacher?: string | null;
    period?: string | null;
    term?: string | null;
    url?: string | null;
    percent?: number | null;
    letter?: string | null;
    categories?: { name?: string; weight?: number }[];
  }[];
  assignments?: {
    sourceId?: string;
    student?: string;
    studentSourceId?: string;
    course?: string;
    courseSourceId?: string;
    title?: string;
    due?: string | null;
    assigned?: string | null;
    status?: string;
    pointsEarned?: number | null;
    pointsPossible?: number | null;
    category?: string | null;
    categoryWeight?: number | null;
    url?: string | null;
    term?: string | null;
    dropped?: boolean;
  }[];
}

/** JSON or CSV shaped like the core model, for scripts that already normalized a source. */
export function parseGeneric(input: string, options?: { now?: string }): ParsedBatch {
  const trimmed = input.trim();
  if (!trimmed) throw new AdapterError('Generic feed is empty', 'generic');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJson(trimmed, options);
  return parseCsv(trimmed, options);
}

function parseJson(input: string, options?: { now?: string }): ParsedBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new AdapterError('Generic JSON is not valid', 'generic');
  }
  const file = parsed as GenericFile;
  const fetchedAt = file.fetchedAt ?? options?.now ?? new Date().toISOString();
  const students = (file.students ?? []).map((student) => {
    const name = collapse(student.name);
    if (!name) throw new AdapterError('Generic student is missing a name', 'generic');
    return {
      sourceId: student.sourceId || `generic:${slug(name)}`,
      name,
      school: collapse(student.school),
    };
  });
  const byName = new Map(students.map((student) => [student.name.toLowerCase(), student.sourceId]));
  const courses = (file.courses ?? []).map((course) => {
    const name = collapse(course.name);
    if (!name) throw new AdapterError('Generic course is missing a name', 'generic');
    const studentSourceId = course.studentSourceId || byName.get(collapse(course.student).toLowerCase()) || '';
    if (!studentSourceId) throw new AdapterError(`Generic course ${name} does not name a student`, 'generic');
    return {
      sourceId: course.sourceId || `generic:${slug(name)}`,
      studentSourceId,
      name,
      teacher: course.teacher ?? null,
      period: course.period ?? null,
      term: course.term ?? null,
      url: course.url ?? null,
      categories: (course.categories ?? [])
        .filter((category) => category.name && category.weight !== undefined)
        .map((category) => ({ name: category.name!, weight: Number(category.weight) })),
      percent: course.percent ?? null,
      letter: course.letter ?? null,
    };
  });
  const courseByName = new Map(courses.map((course) => [course.name.toLowerCase(), course]));
  const assignments: ParsedAssignment[] = (file.assignments ?? []).map((assignment) => {
    const title = collapse(assignment.title);
    if (!title) throw new AdapterError('Generic assignment is missing a title', 'generic');
    const status = collapse(assignment.status || 'assigned');
    if (!isAssignmentStatus(status)) {
      throw new AdapterError(`Generic assignment "${title}" has unknown status "${status}"`, 'generic');
    }
    const course = courseByName.get(collapse(assignment.course).toLowerCase());
    const studentSourceId = assignment.studentSourceId || course?.studentSourceId || byName.get(collapse(assignment.student).toLowerCase()) || '';
    if (!studentSourceId) throw new AdapterError(`Generic assignment "${title}" does not name a student`, 'generic');
    const courseSourceId = assignment.courseSourceId || course?.sourceId || `generic:${slug(assignment.course || title)}`;
    const courseName = course?.name || collapse(assignment.course) || 'Course';
    return {
      sourceId: assignment.sourceId || `generic:${slug(title)}`,
      studentSourceId,
      courseSourceId,
      title,
      courseName,
      due: assignment.due ? parseLooseDate(assignment.due) : null,
      assigned: assignment.assigned ? parseLooseDate(assignment.assigned) : null,
      status: status as AssignmentStatus,
      pointsEarned: assignment.pointsEarned ?? null,
      pointsPossible: assignment.pointsPossible ?? null,
      category: assignment.category ?? null,
      categoryWeight: assignment.categoryWeight ?? null,
      url: assignment.url ?? null,
      term: assignment.term ?? course?.term ?? null,
      dropped: assignment.dropped === true,
      groupKey: `generic:${courseSourceId}:${assignment.term ?? course?.term ?? 'term'}`,
    };
  });
  const grades: ParsedGrade[] = courses
    .filter((course) => course.percent !== null || course.letter)
    .map((course) => ({
      studentSourceId: course.studentSourceId,
      courseSourceId: course.sourceId,
      courseName: course.name,
      percent: course.percent,
      letter: course.letter,
      term: course.term,
      asOf: fetchedAt,
      current: true,
    }));
  const replaceGroups = [...new Set(assignments.map((assignment) => assignment.groupKey))];
  return {
    source: 'generic',
    fetchedAt,
    students,
    courses: courses.map((course) => ({
      sourceId: course.sourceId,
      studentSourceId: course.studentSourceId,
      name: course.name,
      teacher: course.teacher,
      period: course.period,
      term: course.term,
      url: course.url,
      categories: course.categories,
    })),
    assignments,
    grades,
    replaceGroups,
    notes: [],
  };
}

function parseCsv(input: string, options?: { now?: string }): ParsedBatch {
  const rows = parseCsvRows(input);
  const header = rows[0];
  if (!header) throw new AdapterError('Generic CSV is empty', 'generic');
  const columns = header.map((cell) => cell.trim());
  const required = ['student', 'course', 'title'];
  for (const name of required) {
    if (!columns.includes(name)) throw new AdapterError(`Generic CSV is missing a ${name} column`, 'generic');
  }
  const fetchedAt = options?.now ?? new Date().toISOString();
  const records = rows.slice(1).filter((row) => row.some((cell) => collapse(cell)));
  const file: GenericFile = { fetchedAt, students: [], courses: [], assignments: [] };
  const seenStudents = new Set<string>();
  const seenCourses = new Set<string>();
  for (const row of records) {
    const value = (name: string) => {
      const index = columns.indexOf(name);
      return index >= 0 ? collapse(row[index]) : '';
    };
    const student = value('student');
    const school = value('school');
    const course = value('course');
    if (student && !seenStudents.has(student.toLowerCase())) {
      seenStudents.add(student.toLowerCase());
      file.students!.push({ name: student, school, sourceId: `generic:${slug(student)}` });
    }
    const courseKey = `${student.toLowerCase()}::${course.toLowerCase()}`;
    if (course && student && !seenCourses.has(courseKey)) {
      seenCourses.add(courseKey);
      const percent = value('percent');
      const weight = value('categoryWeight');
      file.courses!.push({
        name: course,
        student,
        teacher: value('teacher') || null,
        period: value('period') || null,
        term: value('term') || null,
        sourceId: `generic:${slug(student)}:${slug(course)}`,
        percent: percent ? Number(percent) : null,
        letter: value('letter') || null,
        categories: value('category') && weight ? [{ name: value('category'), weight: Number(weight) }] : [],
      });
    }
    if (value('title')) {
      file.assignments!.push({
        title: value('title'),
        student,
        course,
        courseSourceId: `generic:${slug(student)}:${slug(course)}`,
        due: value('due') || null,
        assigned: value('assigned') || null,
        status: value('status') || 'assigned',
        pointsEarned: value('pointsEarned') ? Number(value('pointsEarned')) : null,
        pointsPossible: value('pointsPossible') ? Number(value('pointsPossible')) : null,
        category: value('category') || null,
        categoryWeight: value('categoryWeight') ? Number(value('categoryWeight')) : null,
        url: value('url') || null,
        term: value('term') || null,
        sourceId: value('sourceId') || `generic:${slug(student)}:${slug(value('title'))}`,
        dropped: value('dropped') === 'true',
      });
    }
  }
  return parseJson(JSON.stringify(file), options);
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
