import type { HTMLElement } from 'node-html-parser';
import { looksLikeTerm, parseLooseDate } from '../dates.js';
import {
  attr,
  bodyRows,
  cellsOf,
  imageAlts,
  isPurple,
  logicalHeaders,
  metaContent,
  parseHtml,
  rowIdNumber,
  savedFrom,
  textOf,
} from '../html.js';
import { AdapterError, type ParsedAssignment, type ParsedBatch, type ParsedGrade, type ParsedStudent } from '../model.js';
import { collapse, slug } from '../text.js';

export interface PowerSchoolPage {
  html: string;
  path?: string;
}

export interface PowerSchoolBundle {
  format?: string;
  exportedAt?: string;
  student?: { name?: string; school?: string; sourceId?: string };
  pages?: { html?: string; path?: string; url?: string }[];
  html?: string;
}

interface CourseSeed {
  sourceId: string;
  studentSourceId: string;
  name: string;
  teacher: string | null;
  period: string | null;
  term: string | null;
  url: string | null;
  categories: { name: string; weight: number }[];
}

/**
 * Parse a saved PowerSchool parent-portal page or a multi-page snapshot.
 * The HTML shape follows the guardian scores page (Class Score Detail) and
 * the guardian home quick-lookup table: linkDescList course header, a grid
 * whose Codes header is colspan 5, and term columns Q1/Q2/S1.
 */
export function parsePowerSchool(input: string, options?: { now?: string }): ParsedBatch {
  const trimmed = input.trim();
  if (!trimmed) throw new AdapterError('PowerSchool snapshot is empty', 'powerschool');
  if (trimmed.startsWith('{')) return parseBundle(JSON.parse(trimmed) as PowerSchoolBundle, options);
  return parsePages([{ html: trimmed }], null, options);
}

function parseBundle(bundle: PowerSchoolBundle, options?: { now?: string }): ParsedBatch {
  const pages: PowerSchoolPage[] = [];
  if (bundle.html) pages.push({ html: bundle.html });
  for (const page of bundle.pages ?? []) {
    if (!page.html) continue;
    pages.push({ html: page.html, path: page.path ?? page.url });
  }
  if (pages.length === 0) {
    throw new AdapterError('PowerSchool bundle has no HTML pages', 'powerschool');
  }
  const fetchedAt = bundle.exportedAt ?? options?.now;
  return parsePages(pages, bundle.student ?? null, fetchedAt ? { ...options, now: fetchedAt } : options);
}

function exportedAtIn(html: string): string | null {
  return /name="school-pulse-exported-at"\s+content="([^"]+)"/i.exec(html)?.[1] ?? null;
}

function parsePages(
  pages: PowerSchoolPage[],
  identity: { name?: string; school?: string; sourceId?: string } | null,
  options?: { now?: string },
): ParsedBatch {
  const fromPages = pages
    .map((page) => exportedAtIn(page.html))
    .filter((value): value is string => Boolean(value))
    .sort();
  const fetchedAt = options?.now ?? fromPages.at(-1) ?? new Date().toISOString();
  let studentName = collapse(identity?.name);
  let school = collapse(identity?.school);
  const courses = new Map<string, CourseSeed>();
  const assignments: ParsedAssignment[] = [];
  const grades: ParsedGrade[] = [];
  const replaceGroups = new Set<string>();
  const notes: string[] = [];

  for (const page of pages) {
    const root = parseHtml(page.html);
    const saved = savedFrom(page.html);
    studentName = studentName || readStudentName(root);
    school = school || readSchool(root);
    const pageFetched = metaContent(root, 'school-pulse-exported-at') ?? fetchedAt;
    const frn = hiddenValue(root, 'frn') ?? saved.frn ?? frnFromLinks(root);
    const term = readSelectedTerm(root) ?? (saved.fg ? looksLikeTerm(saved.fg) : null);

    for (const table of root.querySelectorAll('table')) {
      const headers = logicalHeaders(table).map((h) => h.toLowerCase());
      if (isAssignmentTable(headers)) {
        if (!frn) throw new AdapterError('Scores page is missing the section frn', 'powerschool');
        const headerCourse = courseHeader(root);
        const course = ensureCourse(courses, {
          sourceId: `ps:${frn}`,
          name: headerCourse.name,
          teacher: headerCourse.teacher,
          period: headerCourse.period,
          term,
          url: saved.url,
        });
        const weights = categoryWeights(root);
        if (weights.length > 0) course.categories = weights;
        const groupKey = `ps:${frn}:${term ?? 'term'}`;
        replaceGroups.add(groupKey);
        assignments.push(
          ...readAssignments(table, {
            frn,
            term,
            courseName: course.name,
            categories: course.categories,
            groupKey,
          }),
        );
        if (headerCourse.percent !== null || headerCourse.letter) {
          grades.push({
            studentSourceId: '',
            courseSourceId: course.sourceId,
            courseName: course.name,
            percent: headerCourse.percent,
            letter: headerCourse.letter,
            term,
            asOf: pageFetched,
            current: true,
          });
        }
      } else if (isHomeTable(headers)) {
        const currentTerm = explicitCurrentTerm(table) ?? inferCurrentTerm(table);
        for (const row of readHomeRows(table)) {
          const course = ensureCourse(courses, {
            sourceId: `ps:${row.frn ?? slug(row.name)}`,
            name: row.name,
            teacher: row.teacher,
            period: row.period,
            term: currentTerm,
            url: row.href,
          });
          for (const grade of row.grades) {
            grades.push({
              studentSourceId: '',
              courseSourceId: course.sourceId,
              courseName: course.name,
              percent: grade.percent,
              letter: grade.letter,
              term: grade.term,
              asOf: pageFetched,
              current: grade.term === currentTerm,
            });
          }
        }
      }
    }
  }

  if (!studentName) {
    throw new AdapterError(
      'PowerSchool snapshot is missing the student name (account header or bundle.student.name)',
      'powerschool',
    );
  }
  const studentSourceId = identity?.sourceId ? `ps:${identity.sourceId}` : `ps:name:${slug(studentName)}`;
  const student: ParsedStudent = { sourceId: studentSourceId, name: studentName, school };
  for (const course of courses.values()) course.studentSourceId = studentSourceId;
  for (const assignment of assignments) assignment.studentSourceId = studentSourceId;
  for (const grade of grades) grade.studentSourceId = studentSourceId;

  if (courses.size === 0 && assignments.length === 0) {
    notes.push('No quick-lookup or scores table found in this PowerSchool snapshot.');
  }

  return {
    source: 'powerschool',
    fetchedAt,
    students: [student],
    courses: [...courses.values()],
    assignments,
    grades,
    replaceGroups: [...replaceGroups],
    notes,
  };
}

function ensureCourse(
  courses: Map<string, CourseSeed>,
  seed: Omit<CourseSeed, 'studentSourceId' | 'categories'> & { categories?: CourseSeed['categories'] },
): CourseSeed {
  const existing = courses.get(seed.sourceId);
  if (!existing) {
    const created: CourseSeed = {
      sourceId: seed.sourceId,
      studentSourceId: '',
      name: seed.name || 'Course',
      teacher: seed.teacher,
      period: seed.period,
      term: seed.term,
      url: seed.url,
      categories: seed.categories ?? [],
    };
    courses.set(seed.sourceId, created);
    return created;
  }
  if (seed.name) existing.name = seed.name;
  if (seed.teacher) existing.teacher = seed.teacher;
  if (seed.period) existing.period = seed.period;
  if (seed.term) existing.term = seed.term;
  if (seed.url) existing.url = seed.url;
  if (seed.categories && seed.categories.length > 0) existing.categories = seed.categories;
  return existing;
}

function readStudentName(root: HTMLElement): string {
  for (const selector of ['#account-name', '#student_name', '#studname', '#person-name']) {
    const text = textOf(root.querySelector(selector));
    if (text) return text;
  }
  return '';
}

function readSchool(root: HTMLElement): string {
  for (const selector of ['#school-name', '#school_name', '#schoolName']) {
    const text = textOf(root.querySelector(selector));
    if (text) return text;
  }
  return '';
}

function hiddenValue(root: HTMLElement, name: string): string | null {
  const el = root.querySelector(`input[name="${name}"]`);
  if (!el) return null;
  return attr(el, 'value');
}

function frnFromLinks(root: HTMLElement): string | null {
  for (const link of root.querySelectorAll('a')) {
    const href = attr(link, 'href') ?? '';
    const match = /[?&]frn=([^&"']+)/i.exec(href);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function readSelectedTerm(root: HTMLElement): string | null {
  const select = root.querySelector('select[name="fg"], select#fg');
  if (!select) return null;
  const options = select.querySelectorAll('option');
  const selected = options.find((option) => option.getAttribute('selected') !== undefined) ?? options[0];
  if (!selected) return null;
  return looksLikeTerm(attr(selected, 'value') || textOf(selected));
}

function isAssignmentTable(headers: string[]): boolean {
  const hasDue = headers.some((h) => h.includes('due'));
  const hasAssignment = headers.some((h) => h === 'assignment' || h.startsWith('assignment'));
  return hasDue && hasAssignment;
}

function isHomeTable(headers: string[]): boolean {
  const hasCourse = headers.includes('course');
  const hasTeacher = headers.includes('teacher');
  const terms = headers.filter((h) => looksLikeTerm(h.split(' ')[0] ?? '')).length;
  const hasAbsences = headers.some((h) => h.includes('absence'));
  return hasCourse && hasTeacher && (hasAbsences || terms >= 2) && !isAssignmentTable(headers);
}

interface HeaderCourse {
  name: string;
  teacher: string | null;
  period: string | null;
  percent: number | null;
  letter: string | null;
}

function courseHeader(root: HTMLElement): HeaderCourse {
  const empty: HeaderCourse = { name: '', teacher: null, period: null, percent: null, letter: null };
  for (const table of root.querySelectorAll('table')) {
    const headers = logicalHeaders(table).map((h) => h.toLowerCase());
    if (!headers.includes('course') || !headers.includes('teacher')) continue;
    if (isAssignmentTable(headers) || isHomeTable(headers)) continue;
    const row = bodyRows(table)[0];
    if (!row) continue;
    const cells = cellsOf(row);
    const byName = indexHeaders(logicalHeaders(table));
    const name = cellAt(cells, byName, 'course') || textOf(cells[0]);
    const teacher = cellAt(cells, byName, 'teacher');
    const period = cellAt(cells, byName, 'expression') || cellAt(cells, byName, 'exp');
    const finalRaw = cellAt(cells, byName, 'final grade') || cellAt(cells, byName, 'final');
    const parsed = parseFinal(finalRaw);
    return {
      name,
      teacher: teacher || null,
      period: period || null,
      percent: parsed.percent,
      letter: parsed.letter,
    };
  }
  return empty;
}

function parseFinal(raw: string): { percent: number | null; letter: string | null } {
  if (!raw || raw === '--') return { percent: null, letter: null };
  const letter = /([A-F][+-]?)/i.exec(raw);
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(raw);
  return {
    letter: letter?.[1] ? letter[1].toUpperCase() : null,
    percent: percent?.[1] ? Number(percent[1]) : null,
  };
}

function indexHeaders(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = header.toLowerCase();
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

function cellAt(cells: HTMLElement[], headers: Map<string, number>, name: string): string {
  const index = headers.get(name);
  if (index === undefined) return '';
  return textOf(cells[index]);
}

function categoryWeights(root: HTMLElement): { name: string; weight: number }[] {
  for (const table of root.querySelectorAll('table')) {
    const headers = logicalHeaders(table).map((h) => h.toLowerCase());
    const hasCategory = headers.includes('category');
    const hasWeight = headers.some((h) => h === 'weight' || h.startsWith('weight'));
    if (!hasCategory || !hasWeight || headers.some((h) => h.startsWith('assignment'))) continue;
    const byName = indexHeaders(logicalHeaders(table));
    const raw: { name: string; weight: number }[] = [];
    for (const row of bodyRows(table)) {
      const cells = cellsOf(row);
      const name = cellAt(cells, byName, 'category');
      const weightRaw = textOf(cells[byName.get('weight') ?? -1]);
      if (!name || !weightRaw) continue;
      const num = /(\d+(?:\.\d+)?)\s*%?/.exec(weightRaw);
      if (!num?.[1]) continue;
      raw.push({ name, weight: Number(num[1]) });
    }
    return normalizeWeights(raw);
  }
  return [];
}

/** Percent weights stay as percents. Small relative weights (1, 1, 2) become shares of the total. */
export function normalizeWeights(raw: { name: string; weight: number }[]): { name: string; weight: number }[] {
  if (raw.length === 0) return [];
  const sum = raw.reduce((total, item) => total + item.weight, 0);
  const looksPercent = sum > 10 || raw.some((item) => item.weight > 5);
  if (looksPercent) {
    return raw.map((item) => ({ name: item.name, weight: item.weight }));
  }
  if (sum <= 0) return [];
  return raw.map((item) => ({ name: item.name, weight: Math.round((item.weight / sum) * 1000) / 10 }));
}

function readAssignments(
  table: HTMLElement,
  ctx: {
    frn: string;
    term: string | null;
    courseName: string;
    categories: { name: string; weight: number }[];
    groupKey: string;
  },
): ParsedAssignment[] {
  const headers = logicalHeaders(table);
  const byName = indexHeaders(headers);
  const assignments: ParsedAssignment[] = [];
  for (const row of bodyRows(table)) {
    const cells = cellsOf(row);
    if (cells.length < 3) continue;
    const title = textAt(cells, byName, ['assignment']);
    if (!title || /^teacher comments$/i.test(title)) continue;
    const dueRaw = textAt(cells, byName, ['due date', 'due']);
    const category = textAt(cells, byName, ['category']) || null;
    const scoreRaw = textAt(cells, byName, ['score']);
    const flags = collectFlags(row, cells, byName);
    const purple = cells.some((cell) => isPurple(cell));
    const score = parseScore(scoreRaw);
    const rowNum = rowIdNumber(row);
    const due = parseLooseDate(dueRaw);
    const status = statusFromFlags(flags, score, purple);
    const dropped = flags.has('excluded') || flags.has('dropped');
    const excused = status === 'excused' || flags.has('exempt') || flags.has('excused') || purple;
    const weight = category ? (ctx.categories.find((item) => item.name.toLowerCase() === category.toLowerCase())?.weight ?? null) : null;
    assignments.push({
      sourceId: rowNum ? `ps:assignment:${rowNum}` : `ps:${ctx.frn}:${ctx.term ?? 'term'}:${slug(title)}:${due ?? 'nodue'}`,
      studentSourceId: '',
      courseSourceId: `ps:${ctx.frn}`,
      title,
      courseName: ctx.courseName || 'Course',
      due,
      assigned: null,
      status: excused ? 'excused' : status,
      pointsEarned: score.earned,
      pointsPossible: score.possible,
      category,
      categoryWeight: weight,
      url: null,
      term: ctx.term,
      dropped: dropped && !excused,
      groupKey: ctx.groupKey,
    });
  }
  return assignments;
}

function textAt(cells: HTMLElement[], headers: Map<string, number>, names: string[]): string {
  for (const name of names) {
    const index = headers.get(name);
    if (index === undefined) continue;
    const text = textOf(cells[index]);
    if (text) return text;
  }
  return '';
}

function collectFlags(row: HTMLElement, cells: HTMLElement[], headers: Map<string, number>): Set<string> {
  const flags = new Set<string>();
  const consider = (value: string) => {
    const token = value.toLowerCase();
    if (/collect/.test(token)) flags.add('collected');
    if (/late/.test(token)) flags.add('late');
    if (/miss/.test(token)) flags.add('missing');
    if (/exempt|excus/.test(token)) flags.add('exempt');
    if (/exclud|drop/.test(token)) flags.add('excluded');
    if (token === 'l') flags.add('late');
    if (token === 'm') flags.add('missing');
  };
  for (const [label, index] of headers) {
    if (!label.startsWith('code')) continue;
    const cell = cells[index];
    if (!cell) continue;
    for (const alt of imageAlts(cell)) consider(alt);
    consider(textOf(cell));
  }
  for (const alt of imageAlts(row)) consider(alt);
  return flags;
}

function parseScore(raw: string): { earned: number | null; possible: number | null } {
  const text = collapse(raw);
  if (!text || text === '--' || text === '—') return { earned: null, possible: null };
  const missing = /^(?:--|—|-)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (missing?.[1]) return { earned: null, possible: Number(missing[1]) };
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
  if (frac?.[1] && frac[2]) return { earned: Number(frac[1]), possible: Number(frac[2]) };
  if (/exempt|excused/i.test(text)) return { earned: null, possible: null };
  return { earned: null, possible: null };
}

function statusFromFlags(
  flags: Set<string>,
  score: { earned: number | null },
  purple: boolean,
): ParsedAssignment['status'] {
  if (flags.has('exempt') || flags.has('excused') || purple) return 'excused';
  if (flags.has('missing')) return 'missing';
  if (flags.has('late')) return 'late';
  if (score.earned !== null) return 'graded';
  if (flags.has('collected')) return 'turned_in';
  return 'assigned';
}

function explicitCurrentTerm(table: HTMLElement): string | null {
  for (const cell of table.querySelectorAll('th')) {
    const names = `${attr(cell, 'class') ?? ''}`;
    if (!/\bcurrent\b/.test(names)) continue;
    const term = looksLikeTerm(textOf(cell).split(' ')[0] ?? '');
    if (term) return term;
  }
  return null;
}

function inferCurrentTerm(table: HTMLElement): string | null {
  const headers = logicalHeaders(table);
  const terms: string[] = [];
  for (const header of headers) {
    const term = looksLikeTerm(header.split(' ')[0] ?? '');
    if (term?.startsWith('Q') && !terms.includes(term)) terms.push(term);
  }
  return terms.at(-1) ?? null;
}

interface HomeRow {
  name: string;
  teacher: string | null;
  period: string | null;
  frn: string | null;
  href: string | null;
  grades: { term: string; percent: number | null; letter: string | null }[];
}

function readHomeRows(table: HTMLElement): HomeRow[] {
  const headers = logicalHeaders(table);
  const rows: HomeRow[] = [];
  for (const row of bodyRows(table)) {
    const cells = cellsOf(row);
    const link = row.querySelector('a');
    const href = link ? attr(link, 'href') : null;
    const frn = href ? /[?&]frn=([^&"']+)/i.exec(href)?.[1] ?? null : null;
    const name = link ? textOf(link) : textOf(cells[headers.findIndex((h) => h.toLowerCase() === 'course')]);
    if (!name) continue;
    const byName = indexHeaders(headers);
    const teacher = textAt(cells, byName, ['teacher']) || null;
    const period = textAt(cells, byName, ['exp', 'expression']) || null;
    const grades: HomeRow['grades'] = [];
    headers.forEach((header, index) => {
      const term = looksLikeTerm(header.split(' ')[0] ?? '');
      if (!term) return;
      const kind = header.toLowerCase();
      if (!kind.includes('%') && !kind.includes('percent')) return;
      const percent = parsePlainPercent(textOf(cells[index]));
      const letterIndex = index + 1;
      const letter = parseFinal(textOf(cells[letterIndex])).letter;
      if (percent === null && !letter) return;
      grades.push({ term, percent, letter });
    });
    rows.push({
      name,
      teacher,
      period,
      frn: frn ? decodeURIComponent(frn) : null,
      href,
      grades,
    });
  }
  return rows;
}

function parsePlainPercent(raw: string): number | null {
  if (!raw || raw === '--' || raw === '—') return null;
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  return match?.[1] ? Number(match[1]) : null;
}
