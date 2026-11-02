import { parse, type HTMLElement } from "node-html-parser";
import type { AssignmentStatus } from "../model/types.js";
import { isAssignmentStatus } from "../model/types.js";
import { parseLooseDate } from "../model/dates.js";
import { asNumber, asString, cleanText, slug } from "../util/text.js";
import { emptySnapshot, type NormalizedSnapshot } from "./types.js";

interface LooseRecord {
  [key: string]: unknown;
}

export function parsePowerSchool(raw: string, now: Date): NormalizedSnapshot {
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    return parsePowerSchoolJson(JSON.parse(text) as LooseRecord, now);
  }
  return parsePowerSchoolHtml(text, now);
}

function parsePowerSchoolJson(data: LooseRecord, now: Date): NormalizedSnapshot {
  const fetchedAt = asString(data.fetchedAt) ?? now.toISOString();
  const snapshot = emptySnapshot("powerschool", fetchedAt);
  const students = collectStudents(data);
  if (students.length === 0) students.push({ sourceId: "student", name: "Student", school: null, gradeLevel: null });
  snapshot.students = students;
  const only = students.length === 1 ? students[0]!.sourceId : null;

  const grades = arrayOf(data.finalGrades ?? data.grades);
  for (const grade of grades) {
    const studentSourceId = asString(grade.studentId ?? grade.studentSourceId) ?? only;
    const courseSourceId = asString(grade.sectionId ?? grade.courseId ?? grade.sourceId);
    const name = asString(grade.courseName ?? grade.name ?? grade.course);
    if (!studentSourceId || !courseSourceId || !name) continue;
    ensureCourse(snapshot, {
      sourceId: courseSourceId,
      studentSourceId,
      name,
      teacher: asString(grade.teacher),
      period: asString(grade.period ?? grade.expression),
    });
    const percent = asNumber(grade.percent ?? grade.percentage);
    const letter = letterFrom(grade.grade ?? grade.letter);
    const asOf = asString(grade.asOf ?? grade.date) ?? fetchedAt;
    if (percent == null && !letter) continue;
    snapshot.grades.push({
      studentSourceId,
      courseSourceId,
      percent,
      letter,
      asOf: normalizeDate(asOf, now) ?? fetchedAt,
    });
  }

  for (const item of arrayOf(data.assignments)) {
    const studentSourceId = asString(item.studentId ?? item.studentSourceId) ?? only;
    const courseSourceId = asString(item.sectionId ?? item.courseId ?? item.courseSourceId);
    const title = asString(item.name ?? item.title ?? item.assignmentName);
    if (!studentSourceId || !courseSourceId || !title) continue;
    const courseName = asString(item.courseName) ?? courseSourceId;
    ensureCourse(snapshot, {
      sourceId: courseSourceId,
      studentSourceId,
      name: courseName,
      teacher: asString(item.teacher),
      period: asString(item.period),
    });
    const dueRaw = asString(item.dueDate ?? item.due);
    const assignedRaw = asString(item.assignDate ?? item.assignedDate ?? item.assigned);
    const explicit = asString(item.status);
    snapshot.assignments.push({
      sourceId: asString(item.id ?? item.assignmentId ?? item.sourceId) ?? slug(`${courseSourceId}-${title}`),
      studentSourceId,
      courseSourceId,
      title,
      due: dueRaw ? normalizeDate(dueRaw, now) : null,
      assigned: assignedRaw ? normalizeDate(assignedRaw, now) : null,
      status: explicit && isAssignmentStatus(explicit) ? explicit : statusFromFlags(item),
      pointsEarned: asNumber(item.pointsEarned ?? item.scorePoints ?? item.score),
      pointsPossible: asNumber(item.pointsPossible ?? item.maxPoints),
      category: asString(item.category),
      url: asString(item.url ?? item.href),
    });
  }

  return snapshot;
}

function statusFromFlags(item: LooseRecord): AssignmentStatus {
  if (bool(item.exempt) || bool(item.excused)) return "excused";
  const earned = asNumber(item.pointsEarned ?? item.scorePoints ?? item.score);
  if (bool(item.missing) || bool(item.isMissing)) return earned == null ? "missing" : "graded";
  if (bool(item.late) || bool(item.isLate)) return "late";
  if (earned != null) return "graded";
  if (bool(item.collected) || bool(item.turnedIn)) return "turned_in";
  return "assigned";
}

function parsePowerSchoolHtml(raw: string, now: Date): NormalizedSnapshot {
  const root = parse(raw);
  const fetchedAt = now.toISOString();
  const snapshot = emptySnapshot("powerschool", fetchedAt);
  const name = cleanText(root.querySelector("#studname")?.text ?? root.querySelector("h1")?.text ?? "Student A");
  const school = cleanText(root.querySelector("#schoolname")?.text ?? root.querySelector(".school")?.text ?? "") || null;
  const gradeLevel = cleanText(root.querySelector(".grade-level")?.text ?? "") || null;
  const studentSourceId = slug(name);
  snapshot.students.push({ sourceId: studentSourceId, name, school, gradeLevel });

  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
  const pageCourseId = idFrom(canonical, "frn");
  const pageCourse = cleanText(root.querySelector("h2")?.text ?? "");
  const pageTeacher = cleanText(root.querySelector(".teacher")?.text ?? "") || null;
  const pagePeriod = cleanText(root.querySelector(".period")?.text ?? "") || null;

  if (pageCourse) {
    const courseSourceId = pageCourseId ?? slug(pageCourse);
    ensureCourse(snapshot, {
      sourceId: courseSourceId,
      studentSourceId,
      name: pageCourse,
      teacher: pageTeacher,
      period: pagePeriod,
    });
    const finalText = cleanText(root.querySelector(".finalgrade")?.text ?? "");
    const parsed = parseGradeText(finalText);
    if (parsed.percent != null || parsed.letter) {
      snapshot.grades.push({
        studentSourceId,
        courseSourceId,
        percent: parsed.percent,
        letter: parsed.letter,
        asOf: fetchedAt,
      });
    }
  }

  for (const table of root.querySelectorAll("table")) {
    const parsed = parseTable(table);
    if (!parsed) continue;
    const headers = parsed.headers.map((header) => header.toLowerCase());
    if (headers.some((header) => header.includes("assignment"))) {
      readAssignmentTable(snapshot, parsed, studentSourceId, pageCourseId ?? (pageCourse ? slug(pageCourse) : null), pageCourse || "Class", pageTeacher, pagePeriod, now);
    } else if (headers.some((header) => header === "course" || header.includes("course"))) {
      readGradeTable(snapshot, parsed, studentSourceId, fetchedAt);
    }
  }

  return snapshot;
}

function readGradeTable(
  snapshot: NormalizedSnapshot,
  table: ParsedTable,
  studentSourceId: string,
  fetchedAt: string,
): void {
  const courseIdx = indexOfHeader(table.headers, [/course/i]);
  const teacherIdx = indexOfHeader(table.headers, [/teacher/i]);
  const periodIdx = indexOfHeader(table.headers, [/exp/i, /period/i]);
  const gradeIdx = indexOfHeader(table.headers, [/^q[1-4]$/i, /grade/i, /avg/i, /percent/i]);
  table.rows.forEach((row) => {
    const cells = row.querySelectorAll("th,td");
    const courseCell = cells[courseIdx];
    const name = cleanText(courseCell?.text ?? "");
    if (!name || name.toLowerCase() === "course") return;
    const href = courseCell?.querySelector("a")?.getAttribute("href") ?? "";
    const courseSourceId = idFrom(href, "frn") ?? slug(name);
    const teacher = cleanText(cells[teacherIdx]?.text ?? "") || null;
    const period = cleanText(cells[periodIdx]?.text ?? "") || null;
    ensureCourse(snapshot, { sourceId: courseSourceId, studentSourceId, name, teacher, period });
    const grade = parseGradeText(cells[gradeIdx]?.text ?? "");
    if (grade.percent == null && !grade.letter) return;
    snapshot.grades.push({
      studentSourceId,
      courseSourceId,
      percent: grade.percent,
      letter: grade.letter,
      asOf: fetchedAt,
    });
  });
}

function readAssignmentTable(
  snapshot: NormalizedSnapshot,
  table: ParsedTable,
  studentSourceId: string,
  courseSourceId: string | null,
  courseName: string,
  teacher: string | null,
  period: string | null,
  now: Date,
): void {
  if (!courseSourceId) return;
  ensureCourse(snapshot, { sourceId: courseSourceId, studentSourceId, name: courseName, teacher, period });
  const dueIdx = indexOfHeader(table.headers, [/due/i]);
  const categoryIdx = indexOfHeader(table.headers, [/category/i]);
  const titleIdx = indexOfHeader(table.headers, [/assignment/i]);
  const codesIdx = indexOfHeader(table.headers, [/code/i, /flag/i]);
  const scoreIdx = indexOfHeader(table.headers, [/score/i]);
  table.rows.forEach((row) => {
    const cells = row.querySelectorAll("th,td");
    const titleCell = cells[titleIdx];
    const title = cleanText(titleCell?.text ?? "");
    if (!title || title.toLowerCase() === "assignment") return;
    const href = titleCell?.querySelector("a")?.getAttribute("href") ?? "";
    const sourceId = idFrom(href, "assignmentid") ?? slug(`${courseSourceId}-${title}`);
    const dueText = cleanText(cells[dueIdx]?.text ?? "");
    const due = dueText ? parseLooseDate(dueText, now)?.toISOString() ?? null : null;
    const score = parseScore(cleanText(cells[scoreIdx]?.text ?? ""));
    const codes = cleanText(cells[codesIdx]?.text ?? "");
    snapshot.assignments.push({
      sourceId,
      studentSourceId,
      courseSourceId,
      title,
      due,
      assigned: null,
      status: statusFromCodes(codes, score.earned, due, now),
      pointsEarned: score.earned,
      pointsPossible: score.possible,
      category: cleanText(cells[categoryIdx]?.text ?? "") || null,
      url: href || null,
    });
  });
}

function statusFromCodes(codes: string, earned: number | null, due: string | null, now: Date): AssignmentStatus {
  const text = codes.toLowerCase();
  if (text.includes("exempt") || text.includes("excuse")) return "excused";
  if (text.includes("missing")) return "missing";
  if (text.includes("late")) return "late";
  if (earned != null) return "graded";
  if (text.includes("collected") || text.includes("turned in")) return "turned_in";
  if (due && new Date(due).getTime() < now.getTime()) return "missing";
  return "assigned";
}

function parseScore(text: string): { earned: number | null; possible: number | null } {
  const match = text.replace(/\s/g, "").match(/^(-+|—|–)?(\d+(?:\.\d+)?)?\/(\d+(?:\.\d+)?)$/);
  if (!match) return { earned: null, possible: null };
  return {
    earned: match[2] ? Number(match[2]) : null,
    possible: match[3] ? Number(match[3]) : null,
  };
}

function parseGradeText(input: string): { letter: string | null; percent: number | null } {
  const text = cleanText(input);
  if (!text) return { letter: null, percent: null };
  const letter = readLetter(text);
  const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (percentMatch?.[1]) return { letter, percent: Number(percentMatch[1]) };
  const numbers = [...text.matchAll(/\b(\d{1,3}(?:\.\d+)?)\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value <= 100);
  if (letter && numbers.length > 0) return { letter, percent: numbers[numbers.length - 1] ?? null };
  if (!letter && numbers.length === 1 && text.length <= 8) return { letter, percent: numbers[0] ?? null };
  return { letter, percent: null };
}

interface ParsedTable {
  headers: string[];
  rows: HTMLElement[];
}

function parseTable(table: HTMLElement): ParsedTable | null {
  const rows = table.querySelectorAll("tr");
  const headerRow = rows.find((row) => row.querySelector("th"));
  if (!headerRow) return null;
  const headers = headerRow.querySelectorAll("th,td").map((cell) => cleanText(cell.text));
  const body = rows.filter((row) => row !== headerRow);
  return { headers, rows: body };
}

function indexOfHeader(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function idFrom(href: string, key: string): string | null {
  const match = href.match(new RegExp(`[?&]${key}=([^&]+)`, "i"));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function collectStudents(data: LooseRecord): NormalizedSnapshot["students"] {
  const records = [...(data.student ? [data.student as LooseRecord] : []), ...arrayOf(data.students)];
  return records.map((student) => {
    const joined = [asString(student.firstName), asString(student.lastName)].filter(Boolean).join(" ");
    const name = asString(student.name) ?? (joined || "Student");
    return {
      sourceId: asString(student.id ?? student.sourceId ?? student.studentId) ?? slug(name),
      name,
      school: asString(student.school ?? student.schoolName),
      gradeLevel: asString(student.gradeLevel),
    };
  });
}

function ensureCourse(snapshot: NormalizedSnapshot, course: NormalizedSnapshot["courses"][number]): void {
  const existing = snapshot.courses.find((item) => item.sourceId === course.sourceId && item.studentSourceId === course.studentSourceId);
  if (!existing) {
    snapshot.courses.push(course);
    return;
  }
  if (course.name && existing.name === existing.sourceId) existing.name = course.name;
  existing.teacher ??= course.teacher;
  existing.period ??= course.period;
}

function arrayOf(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? (value as LooseRecord[]) : [];
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function letterFrom(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  return readLetter(text);
}

function readLetter(text: string): string | null {
  const match = text.toUpperCase().match(/(?:^|[^A-Z])([ABCDF][+-]?)(?![A-Z])/);
  return match?.[1] ?? null;
}

function normalizeDate(value: string, now: Date): string | null {
  return parseLooseDate(value, now)?.toISOString() ?? null;
}
