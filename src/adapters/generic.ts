import {
  householdKey,
  parseDue,
  type AssignmentDraft,
  type CourseDraft,
  type GradeDraft,
  type IsoInstant,
  type SchoolSnapshot,
  type StudentDraft,
} from "../domain/index.ts";
import { ok, type Result } from "../domain/index.ts";
import type { AdapterFailure, SchoolAdapter } from "./adapter.ts";
import {
  asNumber,
  asString,
  buildAssignment,
  buildCourse,
  buildFetchedAt,
  buildGrade,
  buildStudent,
  fail,
  isRecord,
  parseError,
  readJson,
  snapshot,
  unsupported,
} from "./guard.ts";

export const genericAdapter: SchoolAdapter = {
  source: "generic",
  formats: ["json", "csv"],
  parse(document) {
    if (document.format === "json") return parseJson(document.text, document.now);
    if (document.format === "csv") return parseCsv(document.text, document.now);
    return unsupported("generic", document.format);
  },
};

function parseJson(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const parsed = readJson(text, "generic");
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return parseError("generic", "expected an object");
  const fetchedAt = buildFetchedAt(parsed.value["fetchedAt"], now, "generic");
  if (!fetchedAt.ok) return fetchedAt;
  const students = [];
  const studentRows = parsed.value["students"];
  if (!Array.isArray(studentRows)) return parseError("generic", "students array is required");
  for (let index = 0; index < studentRows.length; index += 1) {
    const row = studentRows[index];
    if (!isRecord(row)) return parseError("generic", `students[${index}] is not an object`);
    const built = buildStudent("generic", `students[${index}]`, {
      sourceId: asString(row["sourceId"]) ?? "",
      householdKey: asString(row["householdKey"]) ?? "",
      displayName: asString(row["displayName"]) ?? "",
      schoolName: asString(row["schoolName"]),
    });
    if (!built.ok) return built;
    students.push(built.value);
  }
  const byKey = new Map<string, (typeof students)[number]>(students.map((student) => [student.householdKey, student]));
  const courses = [];
  const courseRows = parsed.value["courses"];
  if (!Array.isArray(courseRows)) return parseError("generic", "courses array is required");
  for (let index = 0; index < courseRows.length; index += 1) {
    const row = courseRows[index];
    if (!isRecord(row)) return parseError("generic", `courses[${index}] is not an object`);
    const key = asString(row["householdKey"]) ?? "";
    const student = byKey.get(key);
    if (!student) return parseError("generic", `courses[${index}] references unknown student`);
    const built = buildCourse("generic", `courses[${index}]`, {
      sourceId: asString(row["sourceId"]) ?? "",
      householdKey: student.householdKey,
      name: asString(row["name"]) ?? "",
      teacher: asString(row["teacher"]),
      period: asString(row["period"]),
    });
    if (!built.ok) return built;
    courses.push(built.value);
  }
  const assignments = [];
  const assignmentRows = parsed.value["assignments"] ?? [];
  if (!Array.isArray(assignmentRows)) return parseError("generic", "assignments must be an array");
  for (let index = 0; index < assignmentRows.length; index += 1) {
    const row = assignmentRows[index];
    if (!isRecord(row)) return parseError("generic", `assignments[${index}] is not an object`);
    const earned = asNumber(row["earned"]);
    const possible = asNumber(row["possible"]);
    if (earned === "bad" || possible === "bad") return parseError("generic", `assignments[${index}] points are not numbers`);
    const due = awaitDate(asString(row["dueAt"]) ?? asString(row["due"]), now, `assignments[${index}]`);
    if (!due.ok) return due;
    const assigned = awaitDate(asString(row["assignedAt"]) ?? asString(row["assigned"]), now, `assignments[${index}]`);
    if (!assigned.ok) return assigned;
    const built = buildAssignment("generic", `assignments[${index}]`, {
      sourceId: asString(row["sourceId"]) ?? "",
      householdKey: asString(row["householdKey"]) ?? "",
      courseName: asString(row["courseName"]) ?? asString(row["course"]) ?? "",
      title: asString(row["title"]) ?? "",
      status: asString(row["status"]) ?? "assigned",
      earned,
      possible,
      assignedAt: assigned.value,
      dueAt: due.value,
      category: asString(row["category"]),
      url: asString(row["url"]),
    });
    if (!built.ok) return built;
    assignments.push(built.value);
  }
  const grades = [];
  const gradeRows = parsed.value["grades"] ?? [];
  if (!Array.isArray(gradeRows)) return parseError("generic", "grades must be an array");
  for (let index = 0; index < gradeRows.length; index += 1) {
    const row = gradeRows[index];
    if (!isRecord(row)) return parseError("generic", `grades[${index}] is not an object`);
    const key = asString(row["householdKey"]) ?? "";
    const student = byKey.get(key);
    if (!student) return parseError("generic", `grades[${index}] references unknown student`);
    const course = courses.find((item) => item.householdKey === student.householdKey && (item.sourceId === row["courseSourceId"] || item.name === row["courseName"] || item.name === row["course"]));
    const courseLabel = course?.name ?? asString(row["courseName"]) ?? asString(row["course"]);
    if (!courseLabel) return parseError("generic", `grades[${index}] has no course`);
    const percent = asNumber(row["percent"]);
    if (percent === "bad") return parseError("generic", `grades[${index}].percent is not a number`);
    const asOf = asString(row["asOf"]);
    if (!asOf) return parseError("generic", `grades[${index}].asOf is required`);
    const built = buildGrade("generic", `grades[${index}]`, {
      sourceId: asString(row["sourceId"]) ?? asString(row["courseSourceId"]) ?? "",
      householdKey: student.householdKey,
      courseName: courseLabel,
      percent,
      letter: asString(row["letter"]),
      asOf,
    });
    if (!built.ok) return built;
    grades.push(built.value);
  }
  return ok(snapshot("generic", fetchedAt.value, { students, courses, assignments, grades }));
}

function awaitDate(raw: string | null, now: IsoInstant, path: string): Result<string | null, AdapterFailure> {
  if (raw === null) return ok(null);
  const parsed = parseDue(raw, now);
  if (!parsed.ok) return parseError("generic", `${path} date "${raw}"`);
  return ok(parsed.value);
}

function parseCsv(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const rows = parseCsvRows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const header = rows[0];
  if (!header) return parseError("generic", "CSV is empty");
  const records = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));
  const students: StudentDraft[] = [];
  const courses: CourseDraft[] = [];
  const assignments: AssignmentDraft[] = [];
  const grades: GradeDraft[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const cell = (name: string) => {
      const column = header.indexOf(name);
      if (column < 0) return null;
      const value = record[column]?.trim() ?? "";
      return value.length > 0 ? value : null;
    };
    const kind = (cell("recordType") ?? "").toLowerCase();
    const line = index + 2;
    if (kind === "student") {
      const built = buildStudent("generic", `line ${line}`, {
        sourceId: cell("sourceId") ?? "",
        householdKey: cell("householdKey") ?? "",
        displayName: cell("displayName") ?? "",
        schoolName: cell("schoolName"),
      });
      if (!built.ok) return built;
      students.push(built.value);
    } else if (kind === "course") {
      const key = householdKey(cell("householdKey") ?? "");
      if (!key.ok) return fail("generic", `line ${line}.householdKey`, key.error);
      const built = buildCourse("generic", `line ${line}`, {
        sourceId: cell("sourceId") ?? "",
        householdKey: key.value,
        name: cell("course") ?? "",
        teacher: cell("teacher"),
        period: cell("period"),
      });
      if (!built.ok) return built;
      courses.push(built.value);
    } else if (kind === "assignment") {
      const earned = asNumber(cell("earned"));
      const possible = asNumber(cell("possible"));
      if (earned === "bad" || possible === "bad") return parseError("generic", `line ${line} points are not numbers`);
      const due = awaitDate(cell("due"), now, `line ${line}`);
      if (!due.ok) return due;
      const assigned = awaitDate(cell("assigned"), now, `line ${line}`);
      if (!assigned.ok) return assigned;
      const built = buildAssignment("generic", `line ${line}`, {
        sourceId: cell("sourceId") ?? "",
        householdKey: cell("householdKey") ?? "",
        courseName: cell("course") ?? "",
        title: cell("title") ?? "",
        status: cell("status") ?? "assigned",
        earned,
        possible,
        assignedAt: assigned.value,
        dueAt: due.value,
        category: cell("category"),
        url: cell("url"),
      });
      if (!built.ok) return built;
      assignments.push(built.value);
    } else if (kind === "grade") {
      const percent = asNumber(cell("percent"));
      if (percent === "bad") return parseError("generic", `line ${line} percent is not a number`);
      const asOf = cell("asOf");
      if (!asOf) return parseError("generic", `line ${line} asOf is required`);
      const student = students.find((item) => item.householdKey === cell("householdKey"));
      if (!student) return parseError("generic", `line ${line} references an unknown student`);
      const built = buildGrade("generic", `line ${line}`, {
        sourceId: cell("sourceId") ?? cell("courseSourceId") ?? "",
        householdKey: student.householdKey,
        courseName: cell("course") ?? "",
        percent,
        letter: cell("letter"),
        asOf,
      });
      if (!built.ok) return built;
      grades.push(built.value);
    } else if (kind !== "") {
      return parseError("generic", `line ${line} recordType must be student, course, assignment, or grade`);
    }
  }
  const fetched = records.map((record) => {
    const column = header.indexOf("fetchedAt");
    return column < 0 ? null : record[column]?.trim() || null;
  }).find((value) => value);
  const fetchedAt = buildFetchedAt(fetched ?? null, now, "generic");
  if (!fetchedAt.ok) return fetchedAt;
  return ok(snapshot("generic", fetchedAt.value, { students, courses, assignments, grades }));
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char ?? "";
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
