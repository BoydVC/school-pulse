import { instantFromDate, type IsoInstant, type SchoolSnapshot } from "../domain/index.ts";
import { err, ok, type Result } from "../domain/index.ts";
import type { AdapterFailure } from "./adapter.ts";
import { classroomAdapter } from "./classroom.ts";
import { isRecord, parseError } from "./guard.ts";
import { onenoteAdapter } from "./onenote.ts";
import { stableStringify } from "../hash.ts";

export type LocalStudent = {
  readonly sourceId: string;
  readonly householdKey: string;
  readonly displayName: string;
  readonly schoolName: string | null;
  readonly userId?: string;
};

type FetchLike = typeof fetch;

async function getText(url: string, token: string, fetchImpl: FetchLike, accept: string): Promise<Result<string, string>> {
  if (!url.startsWith("https://")) return err("refusing a non-https school request");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept },
  });
  if (!response.ok) return err(`school request failed with ${response.status}`);
  return ok(await response.text());
}

async function getJsonPages(
  firstUrl: string,
  token: string,
  fetchImpl: FetchLike,
  listKey: string,
): Promise<Result<unknown[], string>> {
  const rows: unknown[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; page < 10 && url; page += 1) {
    const body = await getText(url, token, fetchImpl, "application/json");
    if (!body.ok) return err(body.error);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.value) as unknown;
    } catch {
      return err("school response was not JSON");
    }
    if (!isRecord(parsed)) return err("school response was not an object");
    const list = parsed[listKey];
    if (list !== undefined && !Array.isArray(list)) return err(`school response ${listKey} was not a list`);
    rows.push(...(list ?? []));
    const tokenNext = typeof parsed["nextPageToken"] === "string" ? parsed["nextPageToken"] : "";
    const link = typeof parsed["@odata.nextLink"] === "string" ? parsed["@odata.nextLink"] : "";
    if (tokenNext) {
      const glue = firstUrl.includes("?") ? "&" : "?";
      url = `${firstUrl}${glue}pageToken=${encodeURIComponent(tokenNext)}`;
    } else if (link.startsWith("https://graph.microsoft.com/")) {
      url = link;
    } else {
      url = null;
    }
  }
  return ok(rows);
}

export async function pullGoogleClassroom(options: {
  readonly accessToken: string;
  readonly student: LocalStudent & { readonly userId: string };
  readonly now: IsoInstant;
  readonly fetchImpl?: FetchLike;
}): Promise<Result<{ readonly snapshot: SchoolSnapshot; readonly text: string }, AdapterFailure>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const courses = await getJsonPages(
    "https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=100",
    options.accessToken,
    fetchImpl,
    "courses",
  );
  if (!courses.ok) return parseError("google-classroom", courses.error);
  const courseWork: unknown[] = [];
  const submissions: unknown[] = [];
  for (const course of courses.value) {
    if (!isRecord(course) || typeof course["id"] !== "string") continue;
    const id = encodeURIComponent(course["id"]);
    const work = await getJsonPages(
      `https://classroom.googleapis.com/v1/courses/${id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,
      options.accessToken,
      fetchImpl,
      "courseWork",
    );
    if (!work.ok) return parseError("google-classroom", work.error);
    courseWork.push(...work.value);
    const turnedIn = await getJsonPages(
      `https://classroom.googleapis.com/v1/courses/${id}/courseWork/-/studentSubmissions?userId=${encodeURIComponent(options.student.userId)}&pageSize=100`,
      options.accessToken,
      fetchImpl,
      "studentSubmissions",
    );
    if (!turnedIn.ok) return parseError("google-classroom", turnedIn.error);
    submissions.push(...turnedIn.value);
  }
  const text = stableStringify({
    fetchedAt: options.now,
    student: {
      userId: options.student.userId,
      householdKey: options.student.householdKey,
      displayName: options.student.displayName,
      schoolName: options.student.schoolName,
    },
    courses: courses.value,
    courseWork,
    studentSubmissions: submissions,
  });
  const parsed = classroomAdapter.parse({ format: "json", filename: "classroom.json", text, now: options.now });
  if (!parsed.ok) return parsed;
  return ok({ snapshot: parsed.value, text });
}

export async function pullOneNote(options: {
  readonly accessToken: string;
  readonly student: LocalStudent;
  readonly now: IsoInstant;
  readonly fetchImpl?: FetchLike;
}): Promise<Result<{ readonly snapshot: SchoolSnapshot; readonly text: string }, AdapterFailure>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pages = await getJsonPages(
    "https://graph.microsoft.com/v1.0/me/onenote/pages?$top=50",
    options.accessToken,
    fetchImpl,
    "value",
  );
  if (!pages.ok) return parseError("onenote", pages.error);
  const value = [];
  for (const page of pages.value) {
    if (!isRecord(page) || typeof page["id"] !== "string") continue;
    const content = await getText(
      `https://graph.microsoft.com/v1.0/me/onenote/pages/${encodeURIComponent(page["id"])}/content`,
      options.accessToken,
      fetchImpl,
      "text/html",
    );
    if (!content.ok) return parseError("onenote", content.error);
    value.push({ ...page, content: content.value, studentSourceId: options.student.sourceId });
  }
  const text = stableStringify({
    fetchedAt: options.now,
    student: options.student,
    value,
  });
  const parsed = onenoteAdapter.parse({ format: "json", filename: "onenote.json", text, now: options.now });
  if (!parsed.ok) return parsed;
  return ok({ snapshot: parsed.value, text });
}

export function clock(): IsoInstant {
  return instantFromDate(new Date());
}
