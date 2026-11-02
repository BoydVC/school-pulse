import { isAssignmentStatus } from "../model/types.js";
import { parseLooseDate } from "../model/dates.js";
import { asNumber, asString, slug } from "../util/text.js";
import { emptySnapshot, type NormalizedAssignment, type NormalizedSnapshot } from "./types.js";

interface LooseRecord {
  [key: string]: unknown;
}

export function parseGeneric(raw: string, filename: string, now: Date): NormalizedSnapshot {
  const trimmed = raw.trim();
  if (filename.toLowerCase().endsWith(".csv") || looksLikeCsv(trimmed)) return parseCsv(trimmed, now);
  return parseJson(JSON.parse(trimmed) as LooseRecord, now);
}

function parseJson(data: LooseRecord, now: Date): NormalizedSnapshot {
  const fetchedAt = asString(data.fetchedAt) ?? now.toISOString();
  const snapshot = emptySnapshot("generic", fetchedAt);
  for (const student of arrayOf(data.students)) {
    const name = asString(student.name) ?? "Student";
    snapshot.students.push({
      sourceId: asString(student.sourceId ?? student.id) ?? slug(name),
      name,
      school: asString(student.school),
      gradeLevel: asString(student.gradeLevel),
    });
  }
  for (const course of arrayOf(data.courses)) {
    const name = asString(course.name) ?? "Class";
    const studentSourceId = asString(course.studentSourceId ?? course.studentId);
    if (!studentSourceId) continue;
    snapshot.courses.push({
      sourceId: asString(course.sourceId ?? course.id) ?? slug(name),
      studentSourceId,
      name,
      teacher: asString(course.teacher),
      period: asString(course.period),
    });
  }
  for (const item of arrayOf(data.assignments)) {
    const assignment = readAssignment(item, now);
    if (assignment) snapshot.assignments.push(assignment);
  }
  for (const grade of arrayOf(data.grades)) {
    const studentSourceId = asString(grade.studentSourceId ?? grade.studentId);
    const courseSourceId = asString(grade.courseSourceId ?? grade.courseId);
    if (!studentSourceId || !courseSourceId) continue;
    const asOf = asString(grade.asOf);
    snapshot.grades.push({
      studentSourceId,
      courseSourceId,
      percent: asNumber(grade.percent),
      letter: asString(grade.letter),
      asOf: asOf ? parseLooseDate(asOf, now)?.toISOString() ?? fetchedAt : fetchedAt,
    });
  }
  return snapshot;
}

function readAssignment(item: LooseRecord, now: Date): NormalizedAssignment | null {
  const title = asString(item.title ?? item.name);
  const studentSourceId = asString(item.studentSourceId ?? item.studentId);
  const courseSourceId = asString(item.courseSourceId ?? item.courseId);
  const status = asString(item.status) ?? "assigned";
  if (!title || !studentSourceId || !courseSourceId || !isAssignmentStatus(status)) {
    if (title && studentSourceId && courseSourceId && !isAssignmentStatus(status)) {
      throw new Error(`Unknown assignment status "${status}" on ${title}`);
    }
    return null;
  }
  const due = asString(item.due);
  const assigned = asString(item.assigned);
  return {
    sourceId: asString(item.sourceId ?? item.id) ?? slug(`${courseSourceId}-${title}`),
    studentSourceId,
    courseSourceId,
    title,
    due: due ? parseLooseDate(due, now)?.toISOString() ?? null : null,
    assigned: assigned ? parseLooseDate(assigned, now)?.toISOString() ?? null : null,
    status,
    pointsEarned: asNumber(item.pointsEarned),
    pointsPossible: asNumber(item.pointsPossible),
    category: asString(item.category),
    url: asString(item.url),
  };
}

function parseCsv(raw: string, now: Date): NormalizedSnapshot {
  const fetchedAt = now.toISOString();
  const snapshot = emptySnapshot("generic", fetchedAt);
  const rows = parseCsvRows(raw);
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase());
  if (!header || header.length === 0) throw new Error("CSV is missing a header row");
  const index = new Map(header.map((name, position) => [name, position]));
  const cell = (row: string[], name: string): string => {
    const position = index.get(name);
    return position === undefined ? "" : (row[position] ?? "").trim();
  };
  for (const row of rows.slice(1)) {
    if (row.every((value) => value.trim() === "")) continue;
    const studentName = cell(row, "student") || "Student";
    const studentSourceId = cell(row, "student_id") || slug(studentName);
    const courseName = cell(row, "course") || "Class";
    const courseSourceId = cell(row, "course_id") || slug(`${studentSourceId}-${courseName}`);
    if (!snapshot.students.some((student) => student.sourceId === studentSourceId)) {
      snapshot.students.push({
        sourceId: studentSourceId,
        name: studentName,
        school: cell(row, "school") || null,
        gradeLevel: cell(row, "grade_level") || null,
      });
    }
    if (!snapshot.courses.some((course) => course.sourceId === courseSourceId && course.studentSourceId === studentSourceId)) {
      snapshot.courses.push({
        sourceId: courseSourceId,
        studentSourceId,
        name: courseName,
        teacher: cell(row, "teacher") || null,
        period: cell(row, "period") || null,
      });
    }
    const title = cell(row, "title");
    const status = cell(row, "status") || "assigned";
    if (title) {
      if (!isAssignmentStatus(status)) throw new Error(`Unknown assignment status "${status}" on ${title}`);
      const due = cell(row, "due");
      const assigned = cell(row, "assigned");
      snapshot.assignments.push({
        sourceId: cell(row, "assignment_id") || slug(`${courseSourceId}-${title}`),
        studentSourceId,
        courseSourceId,
        title,
        due: due ? parseLooseDate(due, now)?.toISOString() ?? null : null,
        assigned: assigned ? parseLooseDate(assigned, now)?.toISOString() ?? null : null,
        status,
        pointsEarned: cell(row, "points_earned") === "" ? null : asNumber(cell(row, "points_earned")),
        pointsPossible: cell(row, "points_possible") === "" ? null : asNumber(cell(row, "points_possible")),
        category: cell(row, "category") || null,
        url: cell(row, "url") || null,
      });
    }
    const percent = cell(row, "percent");
    const letter = cell(row, "letter");
    if (percent !== "" || letter !== "") {
      const asOf = cell(row, "as_of");
      snapshot.grades.push({
        studentSourceId,
        courseSourceId,
        percent: percent === "" ? null : asNumber(percent),
        letter: letter || null,
        asOf: asOf ? parseLooseDate(asOf, now)?.toISOString() ?? fetchedAt : fetchedAt,
      });
    }
  }
  return snapshot;
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quoted) {
      if (char === '"') {
        if (raw[i + 1] === '"') {
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
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && raw[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
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

function looksLikeCsv(text: string): boolean {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.includes(",") && line.toLowerCase().includes("student") && !text.startsWith("{") && !text.startsWith("[");
}

function arrayOf(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? (value as LooseRecord[]) : [];
}
