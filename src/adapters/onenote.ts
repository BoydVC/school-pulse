import type { HTMLElement } from 'node-html-parser';
import { looksLikeTerm, parseLooseDate } from '../dates.js';
import { attr, cellsOf, directRows, logicalHeaders, metaContent, parseHtml, textOf } from '../html.js';
import {
  AdapterError,
  type AssignmentStatus,
  type ParsedAssignment,
  type ParsedBatch,
  type ParsedCourse,
  type ParsedStudent,
} from '../model.js';
import { collapse, slug } from '../text.js';

interface GraphPage {
  id?: string;
  title?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  contentUrl?: string;
  content?: string;
  links?: { oneNoteWebUrl?: { href?: string }; oneNoteClientUrl?: { href?: string } };
  parentSection?: GraphSection | null;
  parentNotebook?: { id?: string; displayName?: string; name?: string } | null;
  parentSectionGroup?: GraphSection | null;
}

interface GraphSection {
  id?: string;
  displayName?: string;
  name?: string;
  parentNotebook?: { id?: string; displayName?: string; name?: string } | null;
  parentSectionGroup?: GraphSection | null;
}

const SYSTEM_GROUPS = new Set(
  [
    '_content library',
    'content library',
    '_collaboration space',
    'collaboration space',
    '_teacher only',
    'teacher only',
  ],
);

/**
 * Parse Microsoft Graph onenotePage resources (HTML from GET .../pages/{id}/content
 * inlined as `content`) or a raw page export. Due dates are read from the page;
 * Graph does not provide a separate assignment resource for class-notebook homework.
 */
export function parseOneNote(input: string, options?: { now?: string }): ParsedBatch {
  const trimmed = input.trim();
  if (!trimmed) throw new AdapterError('OneNote snapshot is empty', 'onenote');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseGraph(JSON.parse(trimmed) as unknown, options);
  return parseHtmlPages(
    [{ html: trimmed, title: null, id: null, ref: null, url: null, course: null, term: null, student: null, school: null }],
    options?.now ?? new Date().toISOString(),
  );
}

function parseGraph(payload: unknown, options?: { now?: string }): ParsedBatch {
  const record = (payload ?? {}) as {
    schoolPulse?: { school?: string; exportedAt?: string; student?: string };
    school?: string;
    exportedAt?: string;
    value?: GraphPage[];
    pages?: { value?: GraphPage[] } | GraphPage[];
    content?: string;
    title?: string;
    id?: string;
  };
  const envelopeSchool = record.schoolPulse?.school ?? record.school ?? null;
  const envelopeStudent = record.schoolPulse?.student ?? null;
  const fetchedAt = record.schoolPulse?.exportedAt ?? record.exportedAt ?? options?.now ?? new Date().toISOString();
  let pages: GraphPage[] = [];
  if (Array.isArray(record.value)) pages = record.value;
  else if (Array.isArray(record.pages)) pages = record.pages;
  else if (record.pages && Array.isArray(record.pages.value)) pages = record.pages.value;
  else if (record.content || record.title) pages = [record as GraphPage];

  if (pages.length === 0) throw new AdapterError('OneNote snapshot has no pages', 'onenote');

  const flat = pages.map((page) => {
    const located = locate(page);
    return {
      html: page.content ?? '',
      title: page.title ?? null,
      id: page.id ?? null,
      ref: page.createdDateTime ?? fetchedAt,
      url: page.links?.oneNoteWebUrl?.href ?? page.contentUrl ?? null,
      course: located.course,
      term: located.term,
      student: located.student ?? envelopeStudent,
      school: envelopeSchool,
      notebookId: located.notebookId,
    };
  });
  if (flat.every((page) => !collapse(page.html))) {
    throw new AdapterError(
      'OneNote page list has no inlined content. Save GET /pages/{id}/content HTML on each page as `content`.',
      'onenote',
    );
  }
  return parseHtmlPages(flat, fetchedAt);
}

function displayName(node: { displayName?: string; name?: string } | null | undefined): string {
  return collapse(node?.displayName || node?.name);
}

function locate(page: GraphPage): {
  student: string | null;
  course: string | null;
  term: string | null;
  notebookId: string | null;
} {
  const names: string[] = [];
  const walk = (group: GraphSection | null | undefined) => {
    if (!group) return;
    const name = displayName(group);
    if (name) names.push(name);
    walk(group.parentSectionGroup);
  };
  walk(page.parentSectionGroup);
  walk(page.parentSection?.parentSectionGroup);
  const notebook = page.parentNotebook ?? page.parentSection?.parentNotebook ?? null;
  const course = displayName(notebook) || null;
  const notebookId = notebook?.id ?? null;
  let student: string | null = null;
  let term: string | null = null;
  for (const name of names) {
    const asTerm = looksLikeTerm(name);
    if (asTerm) term = term ?? asTerm;
    else if (!SYSTEM_GROUPS.has(name.toLowerCase())) student = student ?? name;
  }
  const sectionTerm = looksLikeTerm(displayName(page.parentSection));
  return { student, course, term: term ?? sectionTerm, notebookId };
}

interface FlatPage {
  html: string;
  title: string | null;
  id: string | null;
  ref: string | null;
  url: string | null;
  course: string | null;
  term: string | null;
  student: string | null;
  school: string | null;
  notebookId?: string | null;
}

function parseHtmlPages(pages: FlatPage[], fetchedAt: string): ParsedBatch {
  const students = new Map<string, ParsedStudent>();
  const courses = new Map<string, ParsedCourse>();
  const assignments: ParsedAssignment[] = [];
  const replaceGroups: string[] = [];
  const notes: string[] = [];

  for (const page of pages) {
    if (!collapse(page.html)) continue;
    const root = parseHtml(page.html);
    const ref = (page.ref ?? metaContent(root, 'school-pulse-exported-at') ?? fetchedAt).slice(0, 10);
    const studentName =
      collapse(page.student) ||
      metaContent(root, 'school-pulse-student') ||
      '';
    const school = collapse(page.school) || metaContent(root, 'school-pulse-school') || '';
    const courseName =
      collapse(page.course) ||
      metaContent(root, 'school-pulse-course') ||
      page.title ||
      textOf(root.querySelector('h1')) ||
      'Class notebook';
    const term =
      page.term ||
      looksLikeTerm(metaContent(root, 'school-pulse-term')) ||
      looksLikeTerm(page.title) ||
      termInTitle(page.title) ||
      termInTitle(textOf(root.querySelector('title')));
    if (!studentName) {
      throw new AdapterError(
        'OneNote page is missing the student. Use the class notebook student section group, or schoolPulse.student.',
        'onenote',
      );
    }
    const studentSourceId = `onenote:${slug(studentName)}`;
    students.set(studentSourceId, { sourceId: studentSourceId, name: studentName, school });
    const courseSourceId = `onenote:${page.notebookId || slug(courseName)}`;
    if (!courses.has(courseSourceId)) {
      courses.set(courseSourceId, {
        sourceId: courseSourceId,
        studentSourceId,
        name: courseName,
        teacher: null,
        period: null,
        term,
        url: page.url,
        categories: [],
      });
    }
    const pageId = page.id || slug(page.title || courseName);
    const groupKey = `onenote:${pageId}`;
    replaceGroups.push(groupKey);
    const found = readPageAssignments(root, {
      pageId,
      groupKey,
      courseSourceId,
      courseName,
      studentSourceId,
      term,
      ref,
      url: page.url,
    });
    assignments.push(...found);
    const weightSeen = new Map<string, number>();
    for (const assignment of found) {
      if (assignment.category && assignment.categoryWeight !== null) {
        weightSeen.set(assignment.category, assignment.categoryWeight);
      }
    }
    const course = courses.get(courseSourceId);
    if (course && weightSeen.size > 0) {
      course.categories = [...weightSeen.entries()].map(([name, weight]) => ({ name, weight }));
    }
  }

  if (assignments.length === 0) {
    notes.push('No homework rows or to-do tags found on the OneNote page.');
  }

  return {
    source: 'onenote',
    fetchedAt,
    students: [...students.values()],
    courses: [...courses.values()],
    assignments,
    grades: [],
    replaceGroups,
    notes,
  };
}

function termInTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = /\b(Q[1-4]|S[1-2]|Term\s*[1-4])\b/i.exec(title);
  return match?.[1] ? looksLikeTerm(match[1].replace(/\s+/g, '')) ?? looksLikeTerm(match[1]) : null;
}

function readPageAssignments(
  root: HTMLElement,
  ctx: {
    pageId: string;
    groupKey: string;
    courseSourceId: string;
    courseName: string;
    studentSourceId: string;
    term: string | null;
    ref: string;
    url: string | null;
  },
): ParsedAssignment[] {
  const fromTables = readTables(root, ctx);
  const fromTags = readTaggedParagraphs(root, ctx);
  return [...fromTables, ...fromTags];
}

function tableParts(table: HTMLElement): { labels: string[]; dataRows: HTMLElement[] } {
  const labels = logicalHeaders(table);
  const rows = directRows(table);
  if (labels.length > 0 && labels.some((label) => /assignment|task|homework|due|points|status/i.test(label))) {
    const useSecond = rows.length > 1 && rows[1] !== undefined && cellsOf(rows[1]).every((cell) => cell.tagName === 'TH');
    return { labels, dataRows: rows.slice(useSecond ? 2 : 1) };
  }
  const first = rows[0];
  if (!first) return { labels: [], dataRows: [] };
  const fromCells = cellsOf(first).map((cell) => textOf(cell));
  if (fromCells.some((label) => /assignment|task|homework|due|points|status/i.test(label))) {
    return { labels: fromCells, dataRows: rows.slice(1) };
  }
  return { labels: [], dataRows: [] };
}

function readTables(root: HTMLElement, ctx: { pageId: string; groupKey: string; courseSourceId: string; courseName: string; studentSourceId: string; term: string | null; ref: string; url: string | null }): ParsedAssignment[] {
  const found: ParsedAssignment[] = [];
  for (const table of root.querySelectorAll('table')) {
    const parts = tableParts(table);
    const headers = parts.labels.map((header) => header.toLowerCase());
    if (!headers.some((header) => /assignment|task|homework|title/.test(header))) continue;
    const index = new Map<string, number>();
    parts.labels.forEach((header, i) => index.set(header.toLowerCase(), i));
    let rowIndex = 0;
    for (const row of parts.dataRows) {
      rowIndex += 1;
      const cells = cellsOf(row);
      const title = firstCell(cells, index, ['assignment', 'task', 'homework', 'title']);
      if (!title) continue;
      const dueRaw = firstCell(cells, index, ['due', 'due date', 'date']);
      const pointsRaw = firstCell(cells, index, ['points', 'score', 'pts']);
      const statusRaw = firstCell(cells, index, ['status', 'flag', 'codes']);
      const categoryRaw = firstCell(cells, index, ['category', 'type']);
      const category = splitCategory(categoryRaw);
      const points = parsePoints(pointsRaw);
      const status = statusFromText(statusRaw, title, dueRaw, ctx.ref, false);
      const dataId = attr(row, 'data-id') || attr(cells[0] ?? row, 'data-id');
      found.push(makeAssignment(ctx, dataId || `row-${rowIndex}`, title, dueRaw, points, category.name, category.weight, status));
    }
  }
  return found;
}

function readTaggedParagraphs(
  root: HTMLElement,
  ctx: { pageId: string; groupKey: string; courseSourceId: string; courseName: string; studentSourceId: string; term: string | null; ref: string; url: string | null },
): ParsedAssignment[] {
  const found: ParsedAssignment[] = [];
  const nodes = root.querySelectorAll('[data-tag]');
  let index = 0;
  for (const node of nodes) {
    const tag = (attr(node, 'data-tag') ?? '').toLowerCase();
    if (!/to-do/.test(tag)) continue;
    const title = textOf(node);
    if (!title) continue;
    index += 1;
    const completed = /to-do:completed/.test(tag);
    const points = parsePoints(title);
    const category = splitCategory(title);
    const status = statusFromText('', title, title, ctx.ref, completed);
    const dataId = attr(node, 'data-id') || `todo-${index}`;
    found.push(makeAssignment(ctx, dataId, cleanTitle(title), title, points, category.name, category.weight, status));
  }
  return found;
}

function cleanTitle(text: string): string {
  return collapse(
    text
      .replace(/\bdue(?:\s+date)?\b\s*[:\-]?\s+.*$/i, '')
      .replace(/\(\d+(?:\.\d+)?\s*points?\)/i, '')
      .replace(/\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/, '')
      .replace(/\bcategory\s*:.*/i, '')
      .replace(/[.\s]+$/g, ''),
  ) || collapse(text);
}

function makeAssignment(
  ctx: { pageId: string; groupKey: string; courseSourceId: string; courseName: string; studentSourceId: string; term: string | null; ref: string; url: string | null },
  dataId: string,
  title: string,
  dueRaw: string,
  points: { earned: number | null; possible: number | null },
  category: string | null,
  categoryWeight: number | null,
  status: { status: AssignmentStatus; dropped: boolean },
): ParsedAssignment {
  return {
    sourceId: `onenote:${ctx.pageId}:${slug(dataId)}`,
    studentSourceId: ctx.studentSourceId,
    courseSourceId: ctx.courseSourceId,
    title,
    courseName: ctx.courseName,
    due: parseLooseDate(dueRaw, ctx.ref),
    assigned: null,
    status: status.status,
    pointsEarned: points.earned,
    pointsPossible: points.possible,
    category,
    categoryWeight,
    url: ctx.url,
    term: ctx.term,
    dropped: status.dropped,
    groupKey: ctx.groupKey,
  };
}

function firstCell(cells: HTMLElement[], index: Map<string, number>, names: string[]): string {
  for (const [header, cellIndex] of index) {
    if (names.some((name) => header === name || header.startsWith(name))) {
      return textOf(cells[cellIndex]);
    }
  }
  return '';
}

function splitCategory(raw: string | null | undefined): { name: string | null; weight: number | null } {
  const text = collapse(raw);
  if (!text) return { name: null, weight: null };
  const weighted = /([A-Za-z][A-Za-z ]{0,40}?)\s*\((\d+(?:\.\d+)?)%\)/.exec(text);
  if (weighted?.[1] && weighted[2]) return { name: collapse(weighted[1]), weight: Number(weighted[2]) };
  if (text.length <= 40 && !/\bdue\b/i.test(text) && !/\d/.test(text)) return { name: text, weight: null };
  return { name: null, weight: null };
}

function parsePoints(raw: string): { earned: number | null; possible: number | null } {
  const text = collapse(raw);
  const frac = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
  if (frac?.[1] && frac[2]) return { earned: Number(frac[1]), possible: Number(frac[2]) };
  const worth = /\((\d+(?:\.\d+)?)\s*points?\)/i.exec(text) ?? /\b(\d+(?:\.\d+)?)\s*points?\b/i.exec(text);
  if (worth?.[1]) return { earned: null, possible: Number(worth[1]) };
  return { earned: null, possible: null };
}

function statusFromText(
  statusCell: string,
  title: string,
  dueRaw: string,
  ref: string,
  completedTag: boolean,
): { status: AssignmentStatus; dropped: boolean } {
  const blob = `${statusCell} ${title}`.toLowerCase();
  if (/\b(excused|exempt)\b/.test(blob)) return { status: 'excused', dropped: false };
  if (/\b(dropped|excluded)\b/.test(blob)) return { status: 'assigned', dropped: true };
  if (completedTag || /\b(graded|turned in|submitted|done|complete)\b/.test(statusCell.toLowerCase())) {
    const earned = parsePoints(statusCell).earned ?? parsePoints(title).earned;
    if (/\blate\b/.test(blob)) return { status: 'late', dropped: false };
    return { status: earned !== null || /\bgraded\b/.test(blob) ? 'graded' : 'turned_in', dropped: false };
  }
  if (/\bmissing\b/.test(blob)) return { status: 'missing', dropped: false };
  if (/\blate\b/.test(blob)) return { status: 'late', dropped: false };
  const due = parseLooseDate(dueRaw, ref);
  if (!completedTag && due && due < ref) return { status: 'missing', dropped: false };
  return { status: 'assigned', dropped: false };
}
