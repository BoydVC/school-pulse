import { instantFromDate, type CourseDraft, type IsoInstant, type SchoolSnapshot } from "../domain/index.ts";
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
  isRecord,
  parseError,
  readJson,
  snapshot,
  unsupported,
} from "./guard.ts";

type DueParts = { readonly year: number; readonly month: number; readonly day: number };
type TimeParts = { readonly hours: number; readonly minutes: number };

function dueInstant(dueDate: DueParts | null, dueTime: TimeParts | null): IsoInstant | null {
  if (!dueDate) return null;
  const hours = dueTime?.hours ?? 23;
  const minutes = dueTime?.minutes ?? 59;
  return instantFromDate(new Date(Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, hours, minutes, 0)));
}

function dateParts(value: unknown): DueParts | null | "bad" {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "bad";
  const year = asNumber(value["year"]);
  const month = asNumber(value["month"]);
  const day = asNumber(value["day"]);
  if (year === "bad" || month === "bad" || day === "bad" || year === null || month === null || day === null) return "bad";
  return { year, month, day };
}

function timeParts(value: unknown): TimeParts | null | "bad" {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "bad";
  const hours = asNumber(value["hours"]);
  const minutes = asNumber(value["minutes"]);
  if (hours === "bad" || minutes === "bad" || hours === null || minutes === null) return "bad";
  return { hours, minutes };
}

function statusFor(input: {
  readonly state: string;
  readonly late: boolean;
  readonly earned: number | null;
  readonly due: IsoInstant | null;
  readonly now: IsoInstant;
}): string {
  if ((input.state === "RETURNED" || input.state === "TURNED_IN") && input.earned !== null) return "graded";
  if (input.state === "TURNED_IN" || input.state === "RETURNED") return input.late ? "late" : "turned_in";
  if (input.late) return "late";
  if (input.due && input.due < input.now) return "missing";
  return "assigned";
}

export const classroomAdapter: SchoolAdapter = {
  source: "google-classroom",
  formats: ["json"],
  parse(document) {
    if (document.format !== "json") return unsupported("google-classroom", document.format);
    return parseExport(document.text, document.now);
  },
};

function parseExport(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const parsed = readJson(text, "google-classroom");
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return parseError("google-classroom", "expected an object");
  const fetchedAt = buildFetchedAt(parsed.value["fetchedAt"], now, "google-classroom");
  if (!fetchedAt.ok) return fetchedAt;
  const studentRecord = parsed.value["student"];
  if (!isRecord(studentRecord)) return parseError("google-classroom", "student is required");
  const userId = asString(studentRecord["userId"]) ?? "";
  const student = buildStudent("google-classroom", "student", {
    sourceId: userId,
    householdKey: asString(studentRecord["householdKey"]) ?? "",
    displayName: asString(studentRecord["displayName"]) ?? "",
    schoolName: asString(studentRecord["schoolName"]),
  });
  if (!student.ok) return student;
  const courseRows = parsed.value["courses"];
  if (!Array.isArray(courseRows)) return parseError("google-classroom", "courses array is required");
  const courses: CourseDraft[] = [];
  const courseNames = new Map<string, CourseDraft["name"]>();
  for (let index = 0; index < courseRows.length; index += 1) {
    const row = courseRows[index];
    if (!isRecord(row)) return parseError("google-classroom", `courses[${index}] is not an object`);
    if (asString(row["courseState"]) === "ARCHIVED") continue;
    const built = buildCourse("google-classroom", `courses[${index}]`, {
      sourceId: asString(row["id"]) ?? "",
      householdKey: student.value.householdKey,
      name: asString(row["name"]) ?? "",
      teacher: asString(row["teacher"]),
      period: asString(row["section"]),
    });
    if (!built.ok) return built;
    courses.push(built.value);
    courseNames.set(built.value.sourceId, built.value.name);
  }
  const workRows = parsed.value["courseWork"];
  if (!Array.isArray(workRows)) return parseError("google-classroom", "courseWork array is required");
  const work = new Map<string, Record<string, unknown>>();
  for (const row of workRows) {
    if (!isRecord(row)) return parseError("google-classroom", "courseWork entries must be objects");
    const id = asString(row["id"]);
    if (!id) return parseError("google-classroom", "courseWork.id is required");
    work.set(id, row);
  }
  const submissionRows = parsed.value["studentSubmissions"];
  if (submissionRows !== undefined && !Array.isArray(submissionRows)) {
    return parseError("google-classroom", "studentSubmissions must be an array");
  }
  const submissions = new Map<string, Record<string, unknown>>();
  for (const row of submissionRows ?? []) {
    if (!isRecord(row)) return parseError("google-classroom", "studentSubmissions entries must be objects");
    const owner = asString(row["userId"]);
    if (owner && owner !== userId) continue;
    const courseWorkId = asString(row["courseWorkId"]);
    if (!courseWorkId) return parseError("google-classroom", "studentSubmissions.courseWorkId is required");
    submissions.set(courseWorkId, row);
  }
  const assignments = [];
  const earnedByCourse = new Map<string, { earned: number; possible: number; asOf: string }>();
  for (const [workId, row] of work) {
    const courseId = asString(row["courseId"]) ?? "";
    const courseName = courseNames.get(courseId);
    if (!courseName) return parseError("google-classroom", `courseWork ${workId} references unknown course ${courseId}`);
    const dueDate = dateParts(row["dueDate"]);
    const dueTime = timeParts(row["dueTime"]);
    if (dueDate === "bad" || dueTime === "bad") return parseError("google-classroom", `courseWork ${workId} has a bad due date`);
    const due = dueInstant(dueDate, dueTime);
    const submission = submissions.get(workId);
    const state = asString(submission?.["state"]) ?? "CREATED";
    const earned = asNumber(submission?.["assignedGrade"]);
    const possible = asNumber(row["maxPoints"]);
    if (earned === "bad" || possible === "bad") return parseError("google-classroom", `courseWork ${workId} points are not numbers`);
    const late = submission?.["late"] === true;
    const status = statusFor({ state, late, earned, due, now });
    const built = buildAssignment("google-classroom", `courseWork ${workId}`, {
      sourceId: asString(submission?.["id"]) ?? workId,
      householdKey: student.value.householdKey,
      courseName,
      title: asString(row["title"]) ?? "",
      status,
      earned: status === "graded" ? earned : status === "late" ? earned : status === "missing" ? 0 : null,
      possible,
      assignedAt: null,
      dueAt: due,
      category: asString(row["workType"]),
      url: asString(row["alternateLink"]),
    });
    if (!built.ok) return built;
    assignments.push(built.value);
    if (status === "graded" && earned !== null && possible !== null) {
      const bucket = earnedByCourse.get(courseId) ?? { earned: 0, possible: 0, asOf: fetchedAt.value };
      bucket.earned += earned;
      bucket.possible += possible;
      const updated = asString(submission?.["updateTime"]);
      if (updated && updated > bucket.asOf) bucket.asOf = updated;
      earnedByCourse.set(courseId, bucket);
    }
  }
  const grades = [];
  const explicit = parsed.value["courseGrades"];
  if (Array.isArray(explicit)) {
    for (let index = 0; index < explicit.length; index += 1) {
      const row = explicit[index];
      if (!isRecord(row)) return parseError("google-classroom", `courseGrades[${index}] is not an object`);
      const courseId = asString(row["courseId"]) ?? "";
      const name = courseNames.get(courseId);
      if (!name) return parseError("google-classroom", `courseGrades[${index}] references unknown course`);
      const percent = asNumber(row["percent"]);
      if (percent === "bad") return parseError("google-classroom", `courseGrades[${index}].percent is not a number`);
      const built = buildGrade("google-classroom", `courseGrades[${index}]`, {
        sourceId: `gc-grade-${courseId}`,
        householdKey: student.value.householdKey,
        courseName: name,
        percent,
        letter: asString(row["letter"]),
        asOf: asString(row["asOf"]) ?? fetchedAt.value,
      });
      if (!built.ok) return built;
      grades.push(built.value);
    }
  } else if (parsed.value["deriveCourseGrades"] === true) {
    for (const [courseId, bucket] of earnedByCourse) {
      const name = courseNames.get(courseId);
      if (!name || bucket.possible <= 0) continue;
      const built = buildGrade("google-classroom", `derived ${courseId}`, {
        sourceId: `gc-derived-${courseId}`,
        householdKey: student.value.householdKey,
        courseName: name,
        percent: Math.round((bucket.earned / bucket.possible) * 1000) / 10,
        letter: null,
        asOf: bucket.asOf,
      });
      if (!built.ok) return built;
      grades.push(built.value);
    }
  }
  return ok(snapshot("google-classroom", fetchedAt.value, { students: [student.value], courses, assignments, grades }));
}
