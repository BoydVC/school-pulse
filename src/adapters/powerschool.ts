import { parseDue, type IsoInstant, type SchoolSnapshot } from "../domain/index.ts";
import { ok, type Result } from "../domain/index.ts";
import type { SchoolAdapter } from "./adapter.ts";
import type { AdapterFailure } from "./adapter.ts";
import {
  asNumber,
  asString,
  buildAssignment,
  buildCourse,
  buildFetchedAt,
  buildGrade,
  buildStudent,
  isRecord,
  parseError,
  readJson,
  snapshot,
  unsupported,
} from "./guard.ts";
import { cell, elements, hasClass, textContent, attr } from "./html.ts";

function splitScore(raw: string | null): { earned: number | null; possible: number | null } | "bad" {
  if (raw === null || raw === "--" || raw === "—") return { earned: null, possible: null };
  const fraction = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (fraction?.[1] && fraction[2]) return { earned: Number(fraction[1]), possible: Number(fraction[2]) };
  const earned = Number(raw);
  if (Number.isFinite(earned)) return { earned, possible: null };
  return "bad";
}

function cleanStatus(raw: string | null): string {
  if (raw === null || raw === "--" || raw === "—") return "assigned";
  return raw;
}

function dueString(raw: string | null, now: IsoInstant, sourcePath: string, source: "powerschool"): Result<string | null, AdapterFailure> {
  if (raw === null) return ok(null);
  const parsed = parseDue(raw, now);
  if (!parsed.ok) return parseError(source, `${sourcePath} due date "${raw}"`);
  return ok(parsed.value);
}

export const powerschoolAdapter: SchoolAdapter = {
  source: "powerschool",
  formats: ["html", "json"],
  parse(document) {
    if (document.format === "json") return parseJson(document.text, document.now);
    if (document.format === "html") return parseHtml(document.text, document.now);
    return unsupported("powerschool", document.format);
  },
};

function parseJson(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const parsed = readJson(text, "powerschool");
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value) || !Array.isArray(parsed.value["students"])) {
    return parseError("powerschool", "expected a students array");
  }
  const fetchedAt = buildFetchedAt(parsed.value["fetchedAt"], now, "powerschool");
  if (!fetchedAt.ok) return fetchedAt;
  const students = [];
  const courses = [];
  const assignments = [];
  const grades = [];
  for (let studentIndex = 0; studentIndex < parsed.value["students"].length; studentIndex += 1) {
    const student = parsed.value["students"][studentIndex];
    if (!isRecord(student)) return parseError("powerschool", `students[${studentIndex}] is not an object`);
    const builtStudent = buildStudent("powerschool", `students[${studentIndex}]`, {
      sourceId: asString(student["sourceId"]) ?? "",
      householdKey: asString(student["householdKey"]) ?? "",
      displayName: asString(student["displayName"]) ?? "",
      schoolName: asString(student["schoolName"]),
    });
    if (!builtStudent.ok) return builtStudent;
    students.push(builtStudent.value);
    const classes = student["classes"];
    if (!Array.isArray(classes)) return parseError("powerschool", `students[${studentIndex}].classes is required`);
    for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
      const course = classes[classIndex];
      const path = `students[${studentIndex}].classes[${classIndex}]`;
      if (!isRecord(course)) return parseError("powerschool", `${path} is not an object`);
      const builtCourse = buildCourse("powerschool", path, {
        sourceId: asString(course["sourceId"]) ?? "",
        householdKey: builtStudent.value.householdKey,
        name: asString(course["name"]) ?? "",
        teacher: asString(course["teacher"]),
        period: asString(course["period"]),
      });
      if (!builtCourse.ok) return builtCourse;
      courses.push(builtCourse.value);
      const gradeRows = course["grades"];
      if (Array.isArray(gradeRows)) {
        for (let gradeIndex = 0; gradeIndex < gradeRows.length; gradeIndex += 1) {
          const grade = gradeRows[gradeIndex];
          const gradePath = `${path}.grades[${gradeIndex}]`;
          if (!isRecord(grade)) return parseError("powerschool", `${gradePath} is not an object`);
          const percent = asNumber(grade["percent"]);
          if (percent === "bad") return parseError("powerschool", `${gradePath}.percent is not a number`);
          const asOf = asString(grade["asOf"]);
          if (asOf === null) return parseError("powerschool", `${gradePath}.asOf is required`);
          const built = buildGrade("powerschool", gradePath, {
            sourceId: asString(grade["sourceId"]) ?? String(course["sourceId"] ?? ""),
            householdKey: builtStudent.value.householdKey,
            courseName: builtCourse.value.name,
            percent,
            letter: asString(grade["letter"]),
            asOf,
          });
          if (!built.ok) return built;
          grades.push(built.value);
        }
      }
      const rows = course["assignments"];
      if (!Array.isArray(rows)) continue;
      for (let assignmentIndex = 0; assignmentIndex < rows.length; assignmentIndex += 1) {
        const row = rows[assignmentIndex];
        const assignmentPath = `${path}.assignments[${assignmentIndex}]`;
        if (!isRecord(row)) return parseError("powerschool", `${assignmentPath} is not an object`);
        const earned = asNumber(row["earned"]);
        const possible = asNumber(row["possible"]);
        if (earned === "bad" || possible === "bad") return parseError("powerschool", `${assignmentPath} points are not numbers`);
        const due = dueString(asString(row["due"]), now, assignmentPath, "powerschool");
        if (!due.ok) return due;
        const assigned = dueString(asString(row["assigned"]), now, assignmentPath, "powerschool");
        if (!assigned.ok) return assigned;
        const built = buildAssignment("powerschool", assignmentPath, {
          sourceId: asString(row["sourceId"]) ?? "",
          householdKey: builtStudent.value.householdKey,
          courseName: builtCourse.value.name,
          title: asString(row["title"]) ?? "",
          status: cleanStatus(asString(row["status"])),
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
    }
  }
  return ok(snapshot("powerschool", fetchedAt.value, { students, courses, assignments, grades }));
}

function parseHtml(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const headers = [...elements(text, "header"), ...elements(text, "div")].filter((element) =>
    hasClass(element.attrs, "student"),
  );
  const header = headers[0];
  if (!header) return parseError("powerschool", "missing student header");
  const heading = elements(header.inner, "h1")[0];
  const school = elements(header.inner, "p").find((element) => hasClass(element.attrs, "school"));
  const time = elements(text, "time")[0];
  const fetchedAt = buildFetchedAt(time ? attr(time.attrs, "datetime") : null, now, "powerschool");
  if (!fetchedAt.ok) return fetchedAt;
  const builtStudent = buildStudent("powerschool", "student", {
    sourceId: attr(header.attrs, "data-student-id") ?? "",
    householdKey: attr(header.attrs, "data-household-key") ?? "",
    displayName: heading ? textContent(heading.inner) : "",
    schoolName: school ? textContent(school.inner) : null,
  });
  if (!builtStudent.ok) return builtStudent;
  const courses = [];
  const grades = [];
  const assignments = [];
  const gradeTable = elements(text, "table").find((table) => hasClass(table.attrs, "grades"));
  if (!gradeTable) return parseError("powerschool", "missing grades table");
  const gradeRows = elements(gradeTable.inner, "tr").filter((row) => attr(row.attrs, "data-section-id"));
  for (let index = 0; index < gradeRows.length; index += 1) {
    const row = gradeRows[index];
    if (!row) continue;
    const sectionId = attr(row.attrs, "data-section-id") ?? "";
    const builtCourse = buildCourse("powerschool", `grades[${index}]`, {
      sourceId: sectionId,
      householdKey: builtStudent.value.householdKey,
      name: cell(row.inner, "course") ?? "",
      teacher: cell(row.inner, "teacher"),
      period: cell(row.inner, "period"),
    });
    if (!builtCourse.ok) return builtCourse;
    courses.push(builtCourse.value);
    const percentText = (cell(row.inner, "percent") ?? "").replace("%", "");
    const letter = cell(row.inner, "letter");
    if (percentText !== "" || letter) {
      const percent = percentText === "" ? null : Number(percentText);
      if (percent !== null && !Number.isFinite(percent)) return parseError("powerschool", `grades[${index}].percent is not a number`);
      const built = buildGrade("powerschool", `grades[${index}]`, {
        sourceId: sectionId,
        householdKey: builtStudent.value.householdKey,
        courseName: builtCourse.value.name,
        percent,
        letter,
        asOf: fetchedAt.value,
      });
      if (!built.ok) return built;
      grades.push(built.value);
    }
  }
  const assignmentTable = elements(text, "table").find((table) => hasClass(table.attrs, "assignments"));
  if (assignmentTable) {
    const rows = elements(assignmentTable.inner, "tr").filter((row) => attr(row.attrs, "data-assignment-id"));
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const sectionId = attr(row.attrs, "data-section-id");
      const course = courses.find((item) => item.sourceId === sectionId);
      if (!course) return parseError("powerschool", `assignments[${index}] has no class ${sectionId ?? ""}`);
      const score = splitScore(cell(row.inner, "score"));
      if (score === "bad") return parseError("powerschool", `assignments[${index}].score is not a score`);
      const possibleCell = cell(row.inner, "possible");
      const possible = possibleCell === null ? score.possible : Number(possibleCell);
      if (possible !== null && !Number.isFinite(possible)) {
        return parseError("powerschool", `assignments[${index}].possible is not a number`);
      }
      const due = dueString(cell(row.inner, "due"), now, `assignments[${index}]`, "powerschool");
      if (!due.ok) return due;
      const assigned = dueString(cell(row.inner, "assigned"), now, `assignments[${index}]`, "powerschool");
      if (!assigned.ok) return assigned;
      const built = buildAssignment("powerschool", `assignments[${index}]`, {
        sourceId: attr(row.attrs, "data-assignment-id") ?? "",
        householdKey: builtStudent.value.householdKey,
        courseName: course.name,
        title: cell(row.inner, "title") ?? "",
        status: cleanStatus(cell(row.inner, "status")),
        earned: score.earned,
        possible,
        assignedAt: assigned.value,
        dueAt: due.value,
        category: cell(row.inner, "category"),
        url: attr(row.attrs, "data-url"),
      });
      if (!built.ok) return built;
      assignments.push(built.value);
    }
  }
  return ok(
    snapshot("powerschool", fetchedAt.value, {
      students: [builtStudent.value],
      courses,
      assignments,
      grades,
    }),
  );
}
