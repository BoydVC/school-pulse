import { parseDue, type IsoInstant, type SchoolSnapshot } from "../domain/index.ts";
import { ok, type Result } from "../domain/index.ts";
import type { AdapterFailure, SchoolAdapter } from "./adapter.ts";
import {
  asString,
  buildAssignment,
  buildCourse,
  buildFetchedAt,
  buildStudent,
  isRecord,
  parseError,
  readJson,
  snapshot,
  unsupported,
} from "./guard.ts";
import { attr, elements, textContent } from "./html.ts";

type StudentRef = {
  readonly sourceId: string;
  readonly householdKey: string;
  readonly displayName: string;
  readonly schoolName: string | null;
};

function homeworkParts(line: string): { title: string; due: string; status: string } | null {
  const body = line.replace(/^Homework:\s*/i, "").trim();
  const statusMatch = /\.\s*Status:\s*(.+)$/i.exec(body);
  const status = statusMatch?.[1]?.replace(/\.$/, "").trim() || "assigned";
  const beforeStatus = (statusMatch ? body.slice(0, statusMatch.index) : body.replace(/\.$/, "")).trim();
  const dueMatch = /\bDue:\s*(.+)$/i.exec(beforeStatus);
  const due = dueMatch?.[1]?.trim().replace(/\.$/, "");
  if (!dueMatch || !due) return null;
  const title = beforeStatus.slice(0, dueMatch.index).replace(/[.\s]+$/, "").trim();
  if (!title) return null;
  return { title, due, status };
}

function pageSourceId(course: string, title: string, explicit: string | null): string {
  if (explicit) return explicit;
  const slug = `${course}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `on-${slug}`.slice(0, 120);
}

export const onenoteAdapter: SchoolAdapter = {
  source: "onenote",
  formats: ["html", "json"],
  parse(document) {
    if (document.format === "json") return parseJson(document.text, document.now);
    if (document.format === "html") return parseHtml(document.text, document.now, null);
    return unsupported("onenote", document.format);
  },
};

function parseJson(text: string, now: IsoInstant): Result<SchoolSnapshot, AdapterFailure> {
  const parsed = readJson(text, "onenote");
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return parseError("onenote", "expected an object");
  const fetchedAt = buildFetchedAt(
    parsed.value["fetchedAt"] ?? (isRecord(parsed.value["value"]) ? undefined : undefined),
    now,
    "onenote",
  );
  if (!fetchedAt.ok) return fetchedAt;
  const students = new Map<string, StudentRef>();
  const listed = parsed.value["students"];
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (!isRecord(entry)) return parseError("onenote", "students entries must be objects");
      const sourceId = asString(entry["sourceId"]);
      if (!sourceId) return parseError("onenote", "student sourceId is required");
      students.set(sourceId, {
        sourceId,
        householdKey: asString(entry["householdKey"]) ?? "",
        displayName: asString(entry["displayName"]) ?? "",
        schoolName: asString(entry["schoolName"]),
      });
    }
  }
  const single = parsed.value["student"];
  if (isRecord(single)) {
    const sourceId = asString(single["sourceId"]) ?? "on-student";
    students.set(sourceId, {
      sourceId,
      householdKey: asString(single["householdKey"]) ?? "",
      displayName: asString(single["displayName"]) ?? "",
      schoolName: asString(single["schoolName"]),
    });
  }
  const pages = parsed.value["value"];
  if (!Array.isArray(pages)) return parseError("onenote", "expected a Graph pages value array");
  const builtStudents = [];
  const courses = [];
  const assignments = [];
  const seenStudents = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!isRecord(page)) return parseError("onenote", `value[${index}] is not a page`);
    const content = asString(page["content"]);
    if (content === null) return parseError("onenote", `value[${index}].content is required in a snapshot`);
    const linked = asString(page["studentSourceId"]);
    const fallback = linked ? students.get(linked) : [...students.values()][0];
    const parsedPage = parseHtml(content, fetchedAt.value, fallback ?? null, asString(page["title"]));
    if (!parsedPage.ok) return parsedPage;
    for (const student of parsedPage.value.students) {
      if (!seenStudents.has(student.householdKey)) {
        seenStudents.add(student.householdKey);
        builtStudents.push(student);
      }
    }
    courses.push(...parsedPage.value.courses);
    assignments.push(...parsedPage.value.assignments);
  }
  return ok(snapshot("onenote", fetchedAt.value, { students: builtStudents, courses, assignments, grades: [] }));
}

function parseHtml(
  text: string,
  now: IsoInstant,
  fallback: StudentRef | null,
  pageTitle: string | null = null,
): Result<SchoolSnapshot, AdapterFailure> {
  const article = elements(text, "article")[0] ?? elements(text, "body")[0] ?? { attrs: "", inner: text };
  const courseLabel = attr(article.attrs, "data-course") ?? pageTitle?.split("—")[0]?.trim() ?? pageTitle?.split(" - ")[0]?.trim() ?? "";
  const studentInput: StudentRef = {
    sourceId: attr(article.attrs, "data-student-id") ?? fallback?.sourceId ?? "",
    householdKey: attr(article.attrs, "data-household-key") ?? fallback?.householdKey ?? "",
    displayName: attr(article.attrs, "data-student-name") ?? fallback?.displayName ?? "",
    schoolName: attr(article.attrs, "data-school") ?? fallback?.schoolName ?? null,
  };
  const student = buildStudent("onenote", "student", studentInput);
  if (!student.ok) return student;
  const course = buildCourse("onenote", "course", {
    sourceId: `on-course-${student.value.sourceId}-${courseLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.replace(/-+/g, "-"),
    householdKey: student.value.householdKey,
    name: courseLabel,
    teacher: null,
    period: null,
  });
  if (!course.ok) return course;
  const assignments = [];
  const structured = elements(article.inner, "li").filter((item) => attr(item.attrs, "data-source-id"));
  let proseHtml = article.inner;
  for (let index = 0; index < structured.length; index += 1) {
    const item = structured[index];
    if (!item) continue;
    proseHtml = proseHtml.replace(item.inner, " ");
    const dueRaw = attr(item.attrs, "data-due");
    const due = dueRaw === null ? ok(null) : parseDue(dueRaw, now);
    if (!due.ok) return parseError("onenote", `item[${index}] due date "${dueRaw ?? ""}"`);
    const built = buildAssignment("onenote", `item[${index}]`, {
      sourceId: attr(item.attrs, "data-source-id") ?? "",
      householdKey: student.value.householdKey,
      courseName: course.value.name,
      title: textContent(item.inner),
      status: attr(item.attrs, "data-status") ?? "assigned",
      earned: null,
      possible: null,
      assignedAt: null,
      dueAt: due.value,
      category: "Homework",
      url: attr(item.attrs, "data-url"),
    });
    if (!built.ok) return built;
    assignments.push(built.value);
  }
  const prose = textContent(proseHtml)
    .split(/(?=Homework:)/i)
    .map((part) => part.trim())
    .filter((part) => /^homework:/i.test(part));
  for (let index = 0; index < prose.length; index += 1) {
    const line = prose[index];
    if (!line) continue;
    const parts = homeworkParts(line);
    if (!parts) return parseError("onenote", `could not read homework line ${index + 1}`);
    const due = parseDue(parts.due, now);
    if (!due.ok) return parseError("onenote", `homework "${parts.title}" due date "${parts.due}"`);
    const built = buildAssignment("onenote", `homework[${index}]`, {
      sourceId: pageSourceId(course.value.name, parts.title, null),
      householdKey: student.value.householdKey,
      courseName: course.value.name,
      title: parts.title,
      status: parts.status,
      earned: null,
      possible: null,
      assignedAt: null,
      dueAt: due.value,
      category: "Homework",
      url: null,
    });
    if (!built.ok) return built;
    assignments.push(built.value);
  }
  if (assignments.length === 0) return parseError("onenote", "no homework found");
  return ok(
    snapshot("onenote", now, {
      students: [student.value],
      courses: [course.value],
      assignments,
      grades: [],
    }),
  );
}
