import { parse } from "node-html-parser";
import type { AssignmentStatus } from "../model/types.js";
import { parseLooseDate } from "../model/dates.js";
import { asNumber, asString, cleanText, slug } from "../util/text.js";
import { emptySnapshot, type NormalizedSnapshot } from "./types.js";

interface LooseRecord {
  [key: string]: unknown;
}

export function parseOneNote(raw: string, now: Date): NormalizedSnapshot {
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) return parseOneNoteJson(JSON.parse(text) as LooseRecord, now);
  return parseOneNoteHtml(text, now);
}

function parseOneNoteJson(data: LooseRecord, now: Date): NormalizedSnapshot {
  const fetchedAt = asString(data.fetchedAt) ?? asString(data.lastModifiedDateTime) ?? now.toISOString();
  const snapshot = emptySnapshot("onenote", fetchedAt);
  const pages = arrayOf(data.value ?? data.pages);
  const fallbackName = asString((pages[0]?.parentNotebook as LooseRecord | undefined)?.displayName) ?? "Student A";
  const students = collectStudents(data, fallbackName);
  snapshot.students = students;
  const only = students[0]?.sourceId ?? slug(fallbackName);

  for (const course of arrayOf(data.courses)) {
    const studentSourceId = asString(course.studentSourceId ?? course.studentId) ?? only;
    const sourceId = asString(course.sourceId ?? course.id) ?? slug(asString(course.name) ?? "class");
    ensureCourse(snapshot, {
      sourceId,
      studentSourceId,
      name: asString(course.name) ?? "Class",
      teacher: asString(course.teacher),
      period: asString(course.period),
    });
  }

  for (const page of pages) {
    const section = (page.parentSection ?? {}) as LooseRecord;
    const courseName = asString(section.displayName) ?? asString(page.title) ?? "Class";
    const courseSourceId = asString(section.id) ?? slug(courseName);
    const notebookStudent = asString(((page.parentNotebook ?? {}) as LooseRecord).displayName);
    const studentSourceId = students.find((student) => student.name === notebookStudent)?.sourceId ?? only;
    ensureCourse(snapshot, {
      sourceId: courseSourceId,
      studentSourceId,
      name: courseName,
      teacher: asString(section.teacher),
      period: asString(section.period),
    });
    const content = asString(page.content) ?? "";
    const modified = asString(page.lastModifiedDateTime) ?? fetchedAt;
    for (const assignment of assignmentsFromHtml(content, now)) {
      snapshot.assignments.push({
        ...assignment,
        sourceId: `${asString(page.id) ?? courseSourceId}:${slug(assignment.title)}`,
        studentSourceId,
        courseSourceId,
        assigned: modified,
      });
    }
  }

  pushGrades(snapshot, data, only, fetchedAt, now);
  return snapshot;
}

function parseOneNoteHtml(raw: string, now: Date): NormalizedSnapshot {
  const root = parse(raw);
  const fetchedAt = now.toISOString();
  const snapshot = emptySnapshot("onenote", fetchedAt);
  const metaStudent = root.querySelector('meta[name="school-pulse-student"]')?.getAttribute("content") ?? "";
  const metaSchool = root.querySelector('meta[name="school-pulse-school"]')?.getAttribute("content") ?? "";
  const metaGrade = root.querySelector('meta[name="school-pulse-grade"]')?.getAttribute("content") ?? "";
  const title = cleanText(root.querySelector("title")?.text ?? "");
  const split = title.split(/\s+[—–-]\s+/);
  const studentName = cleanText(metaStudent) || cleanText(split.length > 1 ? split[0] ?? "" : "") || "Student A";
  const courseName = cleanText(root.querySelector("h1")?.text ?? "") || cleanText(split.length > 1 ? split[1] ?? "" : split[0] ?? "") || "Class";
  const studentSourceId = slug(studentName);
  const courseSourceId = slug(courseName);
  snapshot.students.push({
    sourceId: studentSourceId,
    name: studentName,
    school: cleanText(metaSchool) || null,
    gradeLevel: cleanText(metaGrade) || null,
  });
  ensureCourse(snapshot, {
    sourceId: courseSourceId,
    studentSourceId,
    name: courseName,
    teacher: null,
    period: null,
  });
  for (const assignment of assignmentsFromHtml(raw, now)) {
    snapshot.assignments.push({
      ...assignment,
      sourceId: slug(`${courseSourceId}-${assignment.title}`),
      studentSourceId,
      courseSourceId,
    });
  }
  return snapshot;
}

function assignmentsFromHtml(html: string, now: Date): Array<Omit<NormalizedSnapshot["assignments"][number], "sourceId" | "studentSourceId" | "courseSourceId">> {
  if (!html.trim()) return [];
  const root = parse(`<div>${html}</div>`);
  const lines = root
    .querySelectorAll("li, p")
    .map((node) => cleanText(node.text))
    .filter((line) => line.length > 0 && !/^homework$/i.test(line) && !/^current grade\b/i.test(line));
  const assignments = [];
  for (const line of lines) {
    const parsed = parseHomeworkLine(line, now);
    if (parsed) assignments.push(parsed);
  }
  return assignments;
}

function parseHomeworkLine(
  line: string,
  now: Date,
): Omit<NormalizedSnapshot["assignments"][number], "sourceId" | "studentSourceId" | "courseSourceId"> | null {
  const flagged = extractFlags(line);
  const text = flagged.text;
  const patterns: Array<{ re: RegExp; title: number; due: number }> = [
    { re: /^due\s+(.+?)\s*[:\-–—]\s*(.+)$/i, title: 2, due: 1 },
    { re: /^(.+?)\s+[—–-]\s+due\s+(.+)$/i, title: 1, due: 2 },
    { re: /^(.+?)\s+\(due\s+(.+?)\)\s*$/i, title: 1, due: 2 },
    { re: /^(.+?)\s+due\s+(.+)$/i, title: 1, due: 2 },
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    const title = cleanText(match?.[pattern.title] ?? "");
    const dueText = cleanText(match?.[pattern.due] ?? "");
    if (!title || !dueText) continue;
    const due = parseLooseDate(dueText, now);
    if (!due) continue;
    return {
      title,
      due: due.toISOString(),
      assigned: null,
      status: flagged.status ?? "assigned",
      pointsEarned: flagged.earned,
      pointsPossible: flagged.possible,
      category: "Homework",
      url: null,
    };
  }
  return null;
}

function extractFlags(line: string): { text: string; status: AssignmentStatus | null; earned: number | null; possible: number | null } {
  let text = line;
  let status: AssignmentStatus | null = null;
  let earned: number | null = null;
  let possible: number | null = null;
  const score = text.match(/(?:^|[\s—–-])(\d+(?:\.\d+)?)\s*\/\s*(\d{1,3}(?:\.\d+)?)(?=$|[\s.,;—–-])/);
  if (score?.[1] && score[2]) {
    earned = Number(score[1]);
    possible = Number(score[2]);
    status = "graded";
    text = text.replace(score[0], " ");
  }
  const flags: Array<[RegExp, AssignmentStatus]> = [
    [/\bmissing\b/i, "missing"],
    [/\blate\b/i, "late"],
    [/\b(turned in|submitted|done)\b/i, "turned_in"],
    [/\b(excused|exempt)\b/i, "excused"],
    [/\bgraded\b/i, "graded"],
  ];
  for (const [pattern, next] of flags) {
    if (pattern.test(text)) {
      status = next;
      text = text.replace(pattern, " ");
    }
  }
  text = cleanText(text).replace(/[—–-]\s*$/g, "").replace(/^due\s+/i, "due ").trim();
  return { text, status, earned, possible };
}

function collectStudents(data: LooseRecord, fallbackName: string): NormalizedSnapshot["students"] {
  const records = [...(data.student ? [data.student as LooseRecord] : []), ...arrayOf(data.students)];
  if (records.length === 0) {
    return [{ sourceId: slug(fallbackName), name: fallbackName, school: null, gradeLevel: null }];
  }
  return records.map((student) => ({
    sourceId: asString(student.sourceId ?? student.id) ?? slug(asString(student.name) ?? fallbackName),
    name: asString(student.name) ?? fallbackName,
    school: asString(student.school),
    gradeLevel: asString(student.gradeLevel),
  }));
}

function pushGrades(snapshot: NormalizedSnapshot, data: LooseRecord, only: string, fetchedAt: string, now: Date): void {
  for (const grade of arrayOf(data.grades)) {
    const studentSourceId = asString(grade.studentSourceId ?? grade.studentId) ?? only;
    const courseName = asString(grade.courseName ?? grade.course) ?? "Class";
    const courseSourceId = asString(grade.courseSourceId ?? grade.courseId) ?? slug(courseName);
    ensureCourse(snapshot, {
      sourceId: courseSourceId,
      studentSourceId,
      name: courseName,
      teacher: asString(grade.teacher),
      period: asString(grade.period),
    });
    const percent = asNumber(grade.percent);
    const letter = asString(grade.letter);
    if (percent == null && !letter) continue;
    const asOf = asString(grade.asOf);
    snapshot.grades.push({
      studentSourceId,
      courseSourceId,
      percent,
      letter,
      asOf: asOf ? parseLooseDate(asOf, now)?.toISOString() ?? fetchedAt : fetchedAt,
    });
  }
}

function ensureCourse(snapshot: NormalizedSnapshot, course: NormalizedSnapshot["courses"][number]): void {
  const existing = snapshot.courses.find((item) => item.sourceId === course.sourceId && item.studentSourceId === course.studentSourceId);
  if (!existing) snapshot.courses.push(course);
  else {
    existing.teacher ??= course.teacher;
    existing.period ??= course.period;
  }
}

function arrayOf(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? (value as LooseRecord[]) : [];
}
