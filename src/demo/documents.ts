import {
  addUtcDays,
  instantFromDate,
  weekdayOffset,
  withinWeek,
  type IsoInstant,
  type Source,
} from "../domain/index.ts";
import { stableStringify } from "../hash.ts";

export type DemoDocument = {
  readonly source: Source;
  readonly filename: string;
  readonly text: string;
};

const BANDS: readonly (readonly [number, string])[] = [
  [97, "A+"],
  [93, "A"],
  [90, "A-"],
  [87, "B+"],
  [83, "B"],
  [80, "B-"],
  [77, "C+"],
  [73, "C"],
  [70, "C-"],
  [67, "D+"],
  [63, "D"],
  [60, "D-"],
];

function letterFor(percent: number): string {
  for (const band of BANDS) {
    if (percent >= band[0]) return band[1];
  }
  return "F";
}

function ago(now: IsoInstant, milliseconds: number): IsoInstant {
  return instantFromDate(new Date(Date.parse(now) - milliseconds));
}

function grade(percent: number, asOf: IsoInstant, sourceId: string) {
  return { sourceId, percent, letter: letterFor(percent), asOf };
}

export function demoDocuments(now: IsoInstant): readonly DemoDocument[] {
  const powerschoolAt = ago(now, 2 * 60 * 60 * 1000);
  const classroomAt = ago(now, 25 * 60 * 1000);
  const onenoteAt = ago(now, 26 * 60 * 60 * 1000);
  const genericAt = ago(now, 3 * 60 * 60 * 1000);
  return [
    { source: "powerschool", filename: "powerschool.json", text: stableStringify(powerSchool(now, powerschoolAt, false)) },
    { source: "google-classroom", filename: "classroom.json", text: stableStringify(classroom(now, classroomAt)) },
    { source: "onenote", filename: "onenote.json", text: stableStringify(oneNote(now, onenoteAt)) },
    { source: "generic", filename: "generic.json", text: stableStringify(generic(now, genericAt)) },
  ];
}

export function liveDocument(now: IsoInstant): DemoDocument {
  return {
    source: "powerschool",
    filename: "powerschool-update.json",
    text: stableStringify(powerSchool(now, now, true)),
  };
}

function powerSchool(now: IsoInstant, fetchedAt: IsoInstant, live: boolean) {
  const friday = addUtcDays(now, weekdayOffset(now, 5));
  const mathGrades = [
    grade(94, addUtcDays(now, -21, 16, 0), "ps-math-7"),
    grade(93, addUtcDays(now, -14, 16, 0), "ps-math-7"),
    grade(91, ago(now, 2 * 60 * 60 * 1000), "ps-math-7"),
  ];
  if (live) mathGrades.push(grade(84, now, "ps-math-7"));
  const scienceAssignments = [
    work("ps-cell", "Cell lab", "missing", null, 20, addUtcDays(now, -6), ago(now, 12 * 86400000), "Lab"),
    work("ps-density", "Density practice", "assigned", null, 12, withinWeek(now, 2), ago(now, 86400000), "Homework"),
  ];
  if (live) scienceAssignments.push(work("ps-science-lab", "Science lab", "assigned", null, 15, friday, fetchedAt, "Lab"));
  return {
    fetchedAt,
    students: [
      {
        sourceId: "ps-stu-a",
        householdKey: "student-a",
        displayName: "Student A",
        schoolName: "Pinecrest Middle",
        classes: [
          {
            sourceId: "ps-math-7",
            name: "Math 7",
            teacher: "Teacher M",
            period: "2",
            grades: mathGrades,
            assignments: [
              work("ps-integers", "Integer patterns", "graded", 18, 20, addUtcDays(now, -8), addUtcDays(now, -12), "Quiz"),
              work("ps-fractions", "Fraction worksheet", "assigned", null, 10, withinWeek(now, 0), ago(now, 2 * 86400000), "Homework"),
            ],
          },
          {
            sourceId: "ps-english-7",
            name: "English 7",
            teacher: "Teacher E",
            period: "3",
            grades: [grade(86, addUtcDays(now, -14, 16, 0), "ps-english-7"), grade(88, ago(now, 2 * 60 * 60 * 1000), "ps-english-7")],
            assignments: [
              work("ps-essay", "Essay outline", "turned_in", null, null, withinWeek(now, 0), addUtcDays(now, -4), "Writing"),
              work("ps-reading", "Reading log", "late", null, 10, addUtcDays(now, -3), addUtcDays(now, -10), "Homework"),
              work("ps-vocab", "Vocab quiz", "graded", 9, 10, addUtcDays(now, -2), addUtcDays(now, -6), "Quiz"),
            ],
          },
          {
            sourceId: "ps-science-7",
            name: "Science 7",
            teacher: "Teacher S",
            period: "4",
            grades: [grade(80, addUtcDays(now, -14, 16, 0), "ps-science-7"), grade(84, ago(now, 2 * 60 * 60 * 1000), "ps-science-7")],
            assignments: scienceAssignments,
          },
        ],
      },
      {
        sourceId: "ps-stu-b",
        householdKey: "student-b",
        displayName: "Student B",
        schoolName: "Pinecrest Middle",
        classes: [
          {
            sourceId: "ps-algebra-8",
            name: "Algebra 8",
            teacher: "Teacher A",
            period: "1",
            grades: [grade(90, addUtcDays(now, -14, 16, 0), "ps-algebra-8"), grade(92, ago(now, 2 * 60 * 60 * 1000), "ps-algebra-8")],
            assignments: [work("ps-warmup", "Algebra warmup", "graded", 10, 10, addUtcDays(now, -4), addUtcDays(now, -6), "Quiz")],
          },
          {
            sourceId: "ps-history-8",
            name: "World History 8",
            teacher: "Teacher H",
            period: "5",
            grades: [
              grade(78, addUtcDays(now, -21, 16, 0), "ps-history-8"),
              grade(81, addUtcDays(now, -14, 16, 0), "ps-history-8"),
              grade(85, ago(now, 2 * 60 * 60 * 1000), "ps-history-8"),
            ],
            assignments: [work("ps-sources", "Source notes", "assigned", null, 10, withinWeek(now, 0), ago(now, 86400000), "Writing")],
          },
          {
            sourceId: "ps-spanish-8",
            name: "Spanish 8",
            teacher: "Teacher L",
            period: "6",
            grades: [grade(96, addUtcDays(now, -14, 16, 0), "ps-spanish-8"), grade(95, ago(now, 2 * 60 * 60 * 1000), "ps-spanish-8")],
            assignments: [],
          },
        ],
      },
    ],
  };
}

function work(
  sourceId: string,
  title: string,
  status: string,
  earned: number | null,
  possible: number | null,
  due: IsoInstant,
  assigned: IsoInstant,
  category: string,
) {
  return { sourceId, title, status, earned, possible, due, assigned, category };
}

function classroom(now: IsoInstant, fetchedAt: IsoInstant) {
  const due = (offset: number) => classroomDue(withinWeek(now, offset));
  const past = (days: number) => classroomDue(addUtcDays(now, days));
  return {
    fetchedAt,
    student: {
      userId: "gc-user-b",
      householdKey: "student-b",
      displayName: "Student B",
      schoolName: "Pinecrest Middle",
    },
    courses: [
      { id: "gc-algebra", name: "Algebra 8", section: "1", courseState: "ACTIVE", alternateLink: "https://example.invalid/classroom/algebra" },
      { id: "gc-history", name: "World History 8", section: "5", courseState: "ACTIVE", alternateLink: "https://example.invalid/classroom/history" },
    ],
    courseWork: [
      { id: "gc-cw-problem", courseId: "gc-algebra", title: "Problem set 4", state: "PUBLISHED", ...due(3), maxPoints: 20, workType: "ASSIGNMENT", alternateLink: "https://example.invalid/classroom/problem" },
      { id: "gc-cw-civ", courseId: "gc-history", title: "Civilizations quiz", state: "PUBLISHED", ...past(-9), maxPoints: 50, workType: "QUIZ", alternateLink: "https://example.invalid/classroom/quiz" },
      { id: "gc-cw-docs", courseId: "gc-history", title: "Document packet", state: "PUBLISHED", ...past(-2), maxPoints: 10, workType: "ASSIGNMENT", alternateLink: "https://example.invalid/classroom/docs" },
    ],
    studentSubmissions: [
      { id: "gc-sub-problem", courseWorkId: "gc-cw-problem", courseId: "gc-algebra", userId: "gc-user-b", state: "CREATED", late: false, assignedGrade: null, updateTime: fetchedAt },
      { id: "gc-sub-civ", courseWorkId: "gc-cw-civ", courseId: "gc-history", userId: "gc-user-b", state: "RETURNED", late: false, assignedGrade: 42, updateTime: fetchedAt },
      { id: "gc-sub-docs", courseWorkId: "gc-cw-docs", courseId: "gc-history", userId: "gc-user-b", state: "CREATED", late: false, assignedGrade: null, updateTime: fetchedAt },
    ],
  };
}

function classroomDue(value: IsoInstant) {
  const date = new Date(value);
  return {
    dueDate: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    dueTime: { hours: date.getUTCHours(), minutes: date.getUTCMinutes() },
  };
}

function oneNote(now: IsoInstant, fetchedAt: IsoInstant) {
  const listeningDue = withinWeek(now, 1);
  const seminarDue = withinWeek(now, 2);
  const friday = addUtcDays(now, weekdayOffset(now, 5));
  return {
    fetchedAt,
    students: [
      { sourceId: "on-stu-b", householdKey: "student-b", displayName: "Student B", schoolName: "Pinecrest Middle" },
      { sourceId: "on-stu-a", householdKey: "student-a", displayName: "Student A", schoolName: "Pinecrest Middle" },
    ],
    value: [
      {
        id: "on-page-spanish",
        studentSourceId: "on-stu-b",
        title: "Spanish 8 — week",
        lastModifiedDateTime: fetchedAt,
        links: { oneNoteWebUrl: { href: "https://example.invalid/notes/spanish" } },
        content: `<article data-course="Spanish 8" data-household-key="student-b" data-student-id="on-stu-b" data-student-name="Student B" data-school="Pinecrest Middle"><p>Homework: Vocabulary set 4. Due: ${friday}. Status: assigned.</p><p>Homework: Listening log. Due: ${listeningDue}. Status: turned in.</p></article>`,
      },
      {
        id: "on-page-english",
        studentSourceId: "on-stu-a",
        title: "English 7 — week",
        lastModifiedDateTime: fetchedAt,
        links: { oneNoteWebUrl: { href: "https://example.invalid/notes/english" } },
        content: `<article data-course="English 7" data-household-key="student-a" data-student-id="on-stu-a" data-student-name="Student A" data-school="Pinecrest Middle"><p>Homework: Seminar notes. Due: ${seminarDue}. Status: assigned.</p></article>`,
      },
    ],
  };
}

function generic(now: IsoInstant, fetchedAt: IsoInstant) {
  return {
    fetchedAt,
    students: [{ sourceId: "gen-stu-a", householdKey: "student-a", displayName: "Student A", schoolName: "Pinecrest Middle" }],
    courses: [{ sourceId: "gen-math", householdKey: "student-a", name: "Math 7", teacher: null, period: null }],
    assignments: [
      {
        sourceId: "gen-practice",
        householdKey: "student-a",
        courseName: "Math 7",
        title: "Practice set",
        status: "assigned",
        earned: null,
        possible: 10,
        dueAt: withinWeek(now, 1),
        assignedAt: ago(now, 86400000),
        category: "Practice",
        url: "https://example.invalid/practice",
      },
    ],
    grades: [],
  };
}
