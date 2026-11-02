import assert from "node:assert/strict";
import test from "node:test";
import { pullGoogleClassroom, pullOneNote } from "../src/adapters/pull.ts";
import { fixture, fixedNow } from "./helpers.ts";

test("classroom pull is read-only and keeps the token out of errors", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    assert.equal(init?.method ?? "GET", "GET");
    if (url.includes("courseWork/-/studentSubmissions")) {
      return Response.json({ studentSubmissions: [] });
    }
    if (url.includes("/courseWork")) return Response.json({ courseWork: [] });
    if (url.endsWith("denied")) return new Response("no", { status: 401 });
    return Response.json({ courses: [{ id: "gc-algebra", name: "Algebra 8", courseState: "ACTIVE" }] });
  };
  const okPull = await pullGoogleClassroom({
    accessToken: "synthetic-token",
    student: { userId: "gc-user-b", sourceId: "gc-user-b", householdKey: "student-b", displayName: "Student B", schoolName: "Pinecrest Middle" },
    now: fixedNow(),
    fetchImpl,
  });
  assert.equal(okPull.ok, true);
  if (okPull.ok) assert.equal(okPull.value.snapshot.courses[0]?.name, "Algebra 8");
  assert.ok(seen.every((url) => url.startsWith("https://classroom.googleapis.com/")));
  const denied: typeof fetch = async () => new Response("synthetic-token", { status: 401 });
  const failed = await pullGoogleClassroom({
    accessToken: "synthetic-token",
    student: { userId: "gc-user-b", sourceId: "gc-user-b", householdKey: "student-b", displayName: "Student B", schoolName: "Pinecrest Middle" },
    now: fixedNow(),
    fetchImpl: denied,
  });
  assert.equal(failed.ok, false);
  if (!failed.ok && failed.error.kind !== "unsupported_format") {
    assert.equal(failed.error.message.includes("synthetic-token"), false);
  }
});

test("onenote pull fetches page HTML only from Graph", async () => {
  const page = fixture("onenote/page.html");
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.method ?? "GET", "GET");
    assert.ok(url.startsWith("https://graph.microsoft.com/"));
    if (url.endsWith("/content")) return new Response(page, { headers: { "content-type": "text/html" } });
    return Response.json({
      value: [{ id: "on-page-spanish", title: "Spanish 8 — week", lastModifiedDateTime: "2026-11-02T16:00:00.000Z" }],
    });
  };
  const parsed = await pullOneNote({
    accessToken: "synthetic-token",
    student: { sourceId: "on-stu-b", householdKey: "student-b", displayName: "Student B", schoolName: "Pinecrest Middle" },
    now: fixedNow(),
    fetchImpl,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.ok(parsed.value.snapshot.assignments.some((row) => row.title === "Vocabulary set 4"));
});
