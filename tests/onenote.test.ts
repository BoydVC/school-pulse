import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot } from "../src/adapters/index.js";
import { zonedParts } from "../src/time/zone.js";
import { fixedNow, fixture } from "./helpers.js";

const now = fixedNow();

test("OneNote graph page HTML becomes assignments", () => {
  const snapshot = parseSnapshot({ source: "onenote", filename: "graph.json", raw: fixture("onenote/graph.json"), now });
  assert.equal(snapshot.students[0]?.name, "Student A");
  const titles = snapshot.assignments.map((item) => item.title).sort();
  assert.deepEqual(titles, ["Chapter questions", "Map skills", "Poster", "Unit quiz"]);
  const map = snapshot.assignments.find((item) => item.title === "Map skills");
  const poster = snapshot.assignments.find((item) => item.title === "Poster");
  const quiz = snapshot.assignments.find((item) => item.title === "Unit quiz");
  assert.equal(zonedParts(new Date(map!.due!)).day, 6);
  assert.equal(zonedParts(new Date(poster!.due!)).day, 3);
  assert.equal(quiz?.status, "graded");
  assert.equal(quiz?.pointsEarned, 9);
  assert.equal(quiz?.pointsPossible, 10);
  assert.equal(snapshot.courses[0]?.name, "History");
});

test("OneNote HTML export uses the student meta and title", () => {
  const snapshot = parseSnapshot({ source: "onenote", filename: "export.html", raw: fixture("onenote/export.html"), now });
  assert.equal(snapshot.students[0]?.name, "Student A");
  assert.equal(snapshot.students[0]?.school, "Pinecrest Middle");
  assert.equal(snapshot.courses[0]?.name, "History");
  assert.equal(snapshot.assignments.length, 2);
  assert.equal(snapshot.assignments.every((item) => item.status === "assigned"), true);
});

test("a graph payload without an envelope still names the notebook", () => {
  const raw = JSON.stringify({
    value: [
      {
        id: "p1",
        title: "Homework",
        parentSection: { id: "sec", displayName: "Science" },
        parentNotebook: { displayName: "Student B" },
        content: "<ul><li>Lab prep — due tomorrow</li></ul>",
      },
    ],
  });
  const snapshot = parseSnapshot({ source: "onenote", filename: "pages.json", raw, now });
  assert.equal(snapshot.students[0]?.name, "Student B");
  assert.equal(snapshot.assignments[0]?.title, "Lab prep");
  assert.equal(snapshot.courses[0]?.name, "Science");
});
