import type { DatabaseSync } from "node:sqlite";
import { parseSnapshot } from "../adapters/index.js";
import { ingestSnapshot } from "../ingest/ingest.js";
import { listStudents } from "../store/db.js";

export function seedDemo(db: DatabaseSync, now: Date): void {
  if (listStudents(db).length > 0) return;
  const story = buildStory(now);
  ingestParsed(db, "powerschool", "powerschool-baseline.json", story.powerschoolBaseline, now);
  ingestParsed(db, "google-classroom", "classroom-baseline.json", story.classroomBaseline, now);
  ingestParsed(db, "onenote", "onenote.json", story.onenote, now);
  ingestParsed(db, "google-classroom", "classroom-update.json", story.classroomUpdate, now);
  ingestParsed(db, "powerschool", "powerschool-update.json", story.powerschoolUpdate, now);
}

function ingestParsed(db: DatabaseSync, source: string, filename: string, body: unknown, now: Date): void {
  const snapshot = parseSnapshot({ source, filename, raw: JSON.stringify(body), now });
  ingestSnapshot(db, snapshot, now);
}

function at(now: Date, dayOffset: number, hours = 23, minutes = 59): string {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function ago(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function weekdayOffset(now: Date, weekday: number): number {
  return (weekday - now.getDay() + 7) % 7;
}

function dueParts(iso: string): { dueDate: { year: number; month: number; day: number }; dueTime: { hours: number; minutes: number } } {
  const date = new Date(iso);
  return {
    dueDate: { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() },
    dueTime: { hours: date.getHours(), minutes: date.getMinutes() },
  };
}

function buildStory(now: Date): {
  powerschoolBaseline: unknown;
  powerschoolUpdate: unknown;
  classroomBaseline: unknown;
  classroomUpdate: unknown;
  onenote: unknown;
} {
  const friday = weekdayOffset(now, 5);
  const lab = {
    id: "asg-lab",
    studentId: "stu-a",
    sectionId: "sec-sci-a",
    courseName: "Science",
    teacher: "Teacher B",
    period: "Period 2",
    name: "Lab report",
    dueDate: at(now, -3),
    assignDate: at(now, -8, 8, 0),
    category: "Lab",
    pointsPossible: 25,
    missing: false,
  };
  const essayDue = at(now, -1);
  const essayWork = {
    courseId: "course-eng-a",
    id: "cw-essay",
    title: "Essay draft",
    workType: "ASSIGNMENT",
    state: "PUBLISHED",
    maxPoints: 40,
    creationTime: at(now, -6, 9, 0),
    alternateLink: "https://classroom.example.test/c/course-eng-a/a/cw-essay",
    ...dueParts(essayDue),
  };

  return {
    powerschoolBaseline: {
      fetchedAt: ago(now, 3 * 24 * 60),
      students: [
        { id: "stu-a", name: "Student A", school: "Pinecrest Middle", gradeLevel: "7" },
        { id: "stu-b", name: "Student B", school: "Riverbend Elementary", gradeLevel: "5" },
      ],
      finalGrades: [
        ...trend("stu-a", "sec-math-a", "Math", "Teacher A", "Period 1", [
          [-28, "A", 96],
          [-21, "A", 95],
          [-14, "A", 94],
          [-7, "A", 93],
          [-2, "A-", 91],
        ], now),
        ...trend("stu-a", "sec-sci-a", "Science", "Teacher B", "Period 2", [
          [-28, "A-", 92],
          [-21, "A-", 90],
          [-14, "B+", 89],
          [-7, "B+", 88],
          [-2, "B", 86],
        ], now),
        ...trend("stu-b", "sec-math-b", "Math", "Teacher E", "Period 1", [
          [-28, "B-", 80],
          [-21, "B-", 82],
          [-14, "B", 85],
          [-7, "B", 86],
          [-2, "A-", 90],
        ], now),
      ],
      assignments: [
        {
          id: "asg-ps-12",
          studentId: "stu-a",
          sectionId: "sec-math-a",
          courseName: "Math",
          name: "Problem set 12",
          dueDate: at(now, 0),
          assignDate: at(now, -2, 8, 0),
          category: "Homework",
          pointsPossible: 20,
        },
        {
          id: "asg-quiz-4",
          studentId: "stu-a",
          sectionId: "sec-math-a",
          courseName: "Math",
          name: "Quiz 4",
          dueDate: at(now, -7),
          assignDate: at(now, -9, 8, 0),
          category: "Quiz",
          score: 18,
          pointsPossible: 20,
        },
        {
          id: "asg-warmup",
          studentId: "stu-a",
          sectionId: "sec-math-a",
          courseName: "Math",
          name: "Warm-up packet",
          dueDate: at(now, -14),
          category: "Classwork",
          score: 10,
          pointsPossible: 10,
        },
        lab,
        {
          id: "asg-cell",
          studentId: "stu-a",
          sectionId: "sec-sci-a",
          courseName: "Science",
          name: "Cell diagram",
          dueDate: at(now, -10),
          category: "Classwork",
          score: 15,
          pointsPossible: 15,
        },
        {
          id: "asg-guide",
          studentId: "stu-a",
          sectionId: "sec-sci-a",
          courseName: "Science",
          name: "Reading guide",
          dueDate: at(now, -1),
          category: "Homework",
          pointsPossible: 10,
          late: true,
        },
        {
          id: "asg-facts",
          studentId: "stu-b",
          sectionId: "sec-math-b",
          courseName: "Math",
          name: "Facts drill",
          dueDate: at(now, 0),
          category: "Homework",
          pointsPossible: 15,
        },
        {
          id: "asg-unit",
          studentId: "stu-b",
          sectionId: "sec-math-b",
          courseName: "Math",
          name: "Unit test",
          dueDate: at(now, -6),
          category: "Quiz",
          score: 42,
          pointsPossible: 50,
        },
      ],
    },
    powerschoolUpdate: {
      fetchedAt: ago(now, 15),
      students: [{ id: "stu-a", name: "Student A", school: "Pinecrest Middle", gradeLevel: "7" }],
      finalGrades: [
        {
          studentId: "stu-a",
          sectionId: "sec-math-a",
          courseName: "Math",
          teacher: "Teacher A",
          period: "Period 1",
          percent: 84,
          grade: "B",
          asOf: ago(now, 15),
        },
      ],
      assignments: [{ ...lab, missing: true }],
    },
    classroomBaseline: {
      fetchedAt: ago(now, 2 * 24 * 60),
      students: [
        { userId: "stu-a", school: "Pinecrest Middle", gradeLevel: "7", profile: { name: { fullName: "Student A" } } },
        { userId: "stu-b", school: "Riverbend Elementary", gradeLevel: "5", profile: { name: { fullName: "Student B" } } },
      ],
      teachers: [
        { courseId: "course-eng-a", profile: { name: { fullName: "Teacher C" } } },
        { courseId: "course-read-b", profile: { name: { fullName: "Teacher F" } } },
      ],
      courses: [
        { id: "course-eng-a", name: "English", section: "Period 3", courseState: "ACTIVE" },
        { id: "course-read-b", name: "Reading", section: "Period 2", courseState: "ACTIVE" },
      ],
      courseWork: [
        essayWork,
        work("course-eng-a", "cw-log", "Reading log", 10, at(now, 0), "https://classroom.example.test/c/course-eng-a/a/cw-log"),
        work("course-eng-a", "cw-vocab", "Vocabulary set", 20, at(now, friday), "https://classroom.example.test/c/course-eng-a/a/cw-vocab"),
        work("course-read-b", "cw-journal", "Response journal", 15, at(now, -2), "https://classroom.example.test/c/course-read-b/a/cw-journal"),
        work("course-read-b", "cw-talk", "Book talk", 20, at(now, 2), "https://classroom.example.test/c/course-read-b/a/cw-talk"),
        { courseId: "course-eng-a", id: "cw-material", title: "Syllabus", workType: "MATERIAL", state: "PUBLISHED" },
      ],
      studentSubmissions: [
        submission("course-eng-a", "cw-essay", "sub-essay", "stu-a", "CREATED"),
        submission("course-eng-a", "cw-log", "sub-log", "stu-a", "CREATED"),
        submission("course-eng-a", "cw-vocab", "sub-vocab", "stu-a", "CREATED"),
        submission("course-read-b", "cw-journal", "sub-journal", "stu-b", "CREATED"),
        submission("course-read-b", "cw-talk", "sub-talk", "stu-b", "CREATED"),
      ],
      grades: [
        ...courseGrades("stu-a", "course-eng-a", [
          [-28, "B+", 88],
          [-21, "B+", 87],
          [-14, "B+", 88],
          [-7, "B+", 88],
          [-2, "B+", 88],
        ], now),
        ...courseGrades("stu-b", "course-read-b", [
          [-28, "C+", 78],
          [-21, "B-", 80],
          [-14, "C+", 77],
          [-7, "C+", 79],
          [-2, "B-", 81],
        ], now),
      ],
    },
    classroomUpdate: {
      fetchedAt: ago(now, 20),
      students: [{ userId: "stu-a", school: "Pinecrest Middle", gradeLevel: "7", profile: { name: { fullName: "Student A" } } }],
      teachers: [{ courseId: "course-eng-a", profile: { name: { fullName: "Teacher C" } } }],
      courses: [{ id: "course-eng-a", name: "English", section: "Period 3", courseState: "ACTIVE" }],
      courseWork: [essayWork],
      studentSubmissions: [submission("course-eng-a", "cw-essay", "sub-essay", "stu-a", "TURNED_IN")],
    },
    onenote: {
      fetchedAt: ago(now, 3 * 24 * 60),
      students: [
        { sourceId: "stu-a", name: "Student A", school: "Pinecrest Middle", gradeLevel: "7" },
        { sourceId: "stu-b", name: "Student B", school: "Riverbend Elementary", gradeLevel: "5" },
      ],
      value: [
        {
          id: "page-history",
          title: "History homework",
          lastModifiedDateTime: ago(now, 3 * 24 * 60),
          parentSection: { id: "sec-hist-a", displayName: "History" },
          parentNotebook: { displayName: "Student A" },
          content: `<html><body><ul><li>Map skills — due ${at(now, friday)}</li><li>Chapter questions — due ${at(now, 1)}</li></ul></body></html>`,
        },
        {
          id: "page-spelling",
          title: "Spelling homework",
          lastModifiedDateTime: ago(now, 3 * 24 * 60),
          parentSection: { id: "sec-spell-b", displayName: "Spelling" },
          parentNotebook: { displayName: "Student B" },
          content: `<html><body><ul><li>Unit 8 list — due ${at(now, 1)}</li><li>Unit 7 list — due ${at(now, -10)} — 18/20</li></ul></body></html>`,
        },
      ],
      grades: [
        ...noteGrades("stu-a", "sec-hist-a", "History", [
          [-28, "A", 93],
          [-21, "A", 94],
          [-14, "A", 94],
          [-7, "A", 95],
          [-2, "A", 95],
        ], now),
        ...noteGrades("stu-b", "sec-spell-b", "Spelling", [
          [-28, "B", 86],
          [-21, "B+", 88],
          [-14, "B+", 87],
          [-7, "A-", 90],
          [-2, "A-", 91],
        ], now),
      ],
    },
  };
}

function trend(
  studentId: string,
  sectionId: string,
  courseName: string,
  teacher: string,
  period: string,
  points: Array<[number, string, number]>,
  now: Date,
): unknown[] {
  return points.map(([day, letter, percent]) => ({
    studentId,
    sectionId,
    courseName,
    teacher,
    period,
    percent,
    grade: letter,
    asOf: at(now, day, 16, 0),
  }));
}

function courseGrades(userId: string, courseId: string, points: Array<[number, string, number]>, now: Date): unknown[] {
  return points.map(([day, letter, percent]) => ({
    userId,
    courseId,
    letter,
    percent,
    asOf: at(now, day, 16, 0),
  }));
}

function noteGrades(studentSourceId: string, courseSourceId: string, courseName: string, points: Array<[number, string, number]>, now: Date): unknown[] {
  return points.map(([day, letter, percent]) => ({
    studentSourceId,
    courseSourceId,
    courseName,
    letter,
    percent,
    asOf: at(now, day, 16, 0),
  }));
}

function work(courseId: string, id: string, title: string, maxPoints: number, due: string, alternateLink: string): unknown {
  return {
    courseId,
    id,
    title,
    workType: "ASSIGNMENT",
    state: "PUBLISHED",
    maxPoints,
    creationTime: due,
    alternateLink,
    ...dueParts(due),
  };
}

function submission(courseId: string, courseWorkId: string, id: string, userId: string, state: string): unknown {
  return { courseId, courseWorkId, id, userId, state, late: false, alternateLink: `https://classroom.example.test/c/${courseId}/a/${courseWorkId}` };
}
