import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SOURCES } from "../src/domain/index.ts";
import { SCHEMA_VERSION, TABLE_NAMES, ddl } from "../src/store/schema.ts";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(ddl());
  return db;
}

test("ddl creates every table and repeats the domain enums", () => {
  const script = ddl();
  assert.equal(SCHEMA_VERSION, 1);
  for (const name of TABLE_NAMES) assert.match(script, new RegExp(`CREATE TABLE ${name}\\b`));
  for (const source of SOURCES) assert.match(script, new RegExp(`'${source}'`));
  const db = memoryDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row["name"]);
  for (const name of TABLE_NAMES) assert.ok(names.includes(name));
  db.close();
});

test("sqlite rejects graded rows without points and empty grade snapshots", () => {
  const db = memoryDb();
  db.exec(`
    INSERT INTO students (id, household_key, display_name, school_name, created_at, updated_at)
    VALUES ('stu_student-a', 'student-a', 'Student A', 'Pinecrest Middle', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    INSERT INTO courses (id, student_id, name, name_key, teacher, period, created_at, updated_at)
    VALUES ('crs_math', 'stu_student-a', 'Math 7', 'math-7', 'Teacher M', '2', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
  `);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO assignments (
        id, student_id, course_id, source, source_id, title, status, earned, possible,
        category, url, assigned_at, due_at, fetched_at, last_seen, content_hash
      ) VALUES ('asg_bad', 'stu_student-a', 'crs_math', 'powerschool', 'ps-bad', 'Quiz', 'graded', NULL, NULL,
        NULL, NULL, NULL, NULL, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'hash')`,
    ).run();
  });
  assert.throws(() => {
    db.prepare(
      `INSERT INTO grade_snapshots (
        id, student_id, course_id, source, source_id, percent, letter, as_of, fetched_at
      ) VALUES ('grd_bad', 'stu_student-a', 'crs_math', 'powerschool', 'ps-math', NULL, NULL, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`,
    ).run();
  });
  assert.throws(() => {
    db.prepare(
      `INSERT INTO grade_snapshots (
        id, student_id, course_id, source, source_id, percent, letter, as_of, fetched_at
      ) VALUES ('grd_hi', 'stu_student-a', 'crs_math', 'powerschool', 'ps-math', 140, 'A', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`,
    ).run();
  });
  db.close();
});
