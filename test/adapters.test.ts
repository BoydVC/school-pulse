import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseClassroom, classroomDueInstant, weightToPercent } from '../src/adapters/classroom.js';
import { parseGeneric } from '../src/adapters/generic.js';
import { parseOneNote } from '../src/adapters/onenote.js';
import { parsePowerSchool } from '../src/adapters/powerschool.js';
import { parseLooseDate } from '../src/dates.js';
import { sniffSource } from '../src/adapters/index.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('loose dates cover portal phrases and weekday abbreviations', () => {
  assert.equal(parseLooseDate('09/10/2026'), '2026-09-10');
  assert.equal(parseLooseDate('Friday, November 6, 2026'), '2026-11-06');
  assert.equal(parseLooseDate('Due Fri', '2026-11-01'), '2026-11-06');
  assert.equal(parseLooseDate(''), null);
  assert.equal(parseLooseDate('--'), null);
});

test('PowerSchool scores page keeps exempt, excluded, missing, late, and a blank due date', () => {
  const early = parsePowerSchool(read('fixtures/powerschool/math-q1-2026-09-15.html'));
  const byTitle = Object.fromEntries(early.assignments.map((item) => [item.title, item]));
  assert.equal(early.students[0]?.name, 'Student A');
  assert.equal(early.students[0]?.school, 'Pinecrest Middle');
  assert.equal(byTitle['Class discussion notes']?.due, null);
  assert.equal(byTitle['Class discussion notes']?.status, 'excused');
  assert.equal(byTitle['Warm-up packet']?.dropped, true);
  assert.equal(byTitle['Makeup worksheet']?.status, 'excused');
  assert.equal(byTitle['Integers practice']?.pointsEarned, 18);
  assert.equal(byTitle['Integers practice']?.pointsPossible, 20);
  assert.equal(byTitle['Integers practice']?.categoryWeight, 20);
  assert.equal(early.courses[0]?.categories.map((item) => item.weight).join(','), '20,30,50');
  assert.equal(early.grades[0]?.percent, 94);
  assert.equal(early.grades[0]?.letter, 'A');
  assert.equal(early.grades[0]?.term, 'Q1');
  assert.ok(!early.assignments.some((item) => item.title.includes('Steady effort')));
});

test('PowerSchool October page adds a late quiz and leaves a future assignment assigned', () => {
  const page = parsePowerSchool(read('fixtures/powerschool/math-q1-2026-10-20.html'));
  const quiz = page.assignments.find((item) => item.title === 'Quiz: Integers');
  const worksheet = page.assignments.find((item) => item.title === 'Equation worksheet');
  assert.equal(quiz?.status, 'late');
  assert.equal(quiz?.pointsEarned, 7);
  assert.equal(worksheet?.status, 'assigned');
  assert.equal(worksheet?.due, '2026-11-04');
  assert.equal(page.grades[0]?.percent, 91);
  assert.equal(page.grades[0]?.letter, 'A-');
});

test('PowerSchool Q2 is a term change and missing wins over a late flag', () => {
  const math = parsePowerSchool(read('fixtures/powerschool/math-q2-2026-11-02.html'));
  const science = parsePowerSchool(read('fixtures/powerschool/science-q2-2026-11-02.html'));
  const english = parsePowerSchool(read('fixtures/powerschool/english-q2-2026-11-02.html'));
  assert.equal(math.grades[0]?.term, 'Q2');
  assert.equal(math.grades[0]?.percent, 84);
  assert.equal(math.grades[0]?.letter, 'B');
  assert.equal(math.assignments.find((item) => item.title === 'Chapter test')?.status, 'missing');
  assert.equal(math.assignments.find((item) => item.title === 'Chapter test')?.pointsPossible, 100);
  const lab = science.assignments.find((item) => item.title === 'Lab report');
  assert.equal(lab?.status, 'missing');
  assert.equal(science.assignments.find((item) => item.title === 'Cell diagram')?.status, 'turned_in');
  const signature = english.assignments.find((item) => item.title === 'Syllabus signature');
  assert.equal(signature?.due, null);
  assert.equal(signature?.status, 'graded');
});

test('PowerSchool home quick lookup keeps older terms without making S1 current', () => {
  const home = parsePowerSchool(read('fixtures/powerschool/home-2026-11-02.html'));
  const math = home.grades.filter((grade) => grade.courseName === 'Math');
  const current = math.find((grade) => grade.current);
  assert.equal(current?.term, 'Q2');
  assert.equal(current?.percent, 84);
  assert.equal(math.find((grade) => grade.term === 'S1')?.current, false);
  assert.equal(math.find((grade) => grade.term === 'S1')?.percent, 88);
  assert.equal(home.courses.length, 3);
});

test('OneNote class notebook page reads Graph HTML, weights, and to-do tags', () => {
  const batch = parseOneNote(read('fixtures/onenote/science-homework.json'));
  assert.equal(batch.students[0]?.name, 'Student A');
  assert.equal(batch.courses[0]?.name, 'Science');
  assert.equal(batch.courses[0]?.term, 'Q2');
  const byTitle = Object.fromEntries(batch.assignments.map((item) => [item.title, item]));
  assert.equal(byTitle['Microscope worksheet']?.due, '2026-11-05');
  assert.equal(byTitle['Microscope worksheet']?.category, 'Lab');
  assert.equal(byTitle['Microscope worksheet']?.categoryWeight, 40);
  assert.equal(byTitle['Microscope worksheet']?.status, 'assigned');
  assert.equal(byTitle['Vocabulary set 4']?.status, 'graded');
  assert.equal(byTitle['Vocabulary set 4']?.pointsEarned, 10);
  assert.equal(byTitle['Museum reflection']?.status, 'excused');
  assert.equal(byTitle['Museum reflection']?.due, null);
  assert.equal(byTitle['Pop quiz']?.dropped, true);
  assert.equal(byTitle['Reading questions']?.due, null);
  assert.equal(byTitle['Reading questions']?.status, 'assigned');
  assert.equal(byTitle['Field sample']?.status, 'late');
  assert.equal(byTitle['Outline']?.status, 'missing');
  assert.equal(byTitle['Graph the results']?.due, '2026-11-06');
  assert.equal(byTitle['Graph the results']?.pointsPossible, 15);
  assert.equal(byTitle['Lab setup checklist']?.status, 'turned_in');
  assert.equal(sniffSource(read('fixtures/onenote/science-homework.json')), 'onenote');
});

test('OneNote raw export resolves "Due Fri" from the page date', () => {
  const batch = parseOneNote(read('fixtures/onenote/raw-page.html'));
  const graph = batch.assignments.find((item) => item.title.startsWith('Graph practice'));
  assert.equal(graph?.due, '2026-11-06');
  assert.equal(graph?.pointsPossible, 10);
  assert.equal(batch.assignments.find((item) => item.title === 'Bring pencils')?.due, null);
  assert.equal(batch.courses[0]?.term, 'Q2');
});

test('Classroom edges: no due date, excused gap, dropped, weighted renormalizing, terms, pages', () => {
  const batch = parseClassroom(read('fixtures/classroom/edges.json'));
  const titles = batch.assignments.map((item) => item.title);
  assert.ok(titles.includes('Page two worksheet'));
  assert.ok(!titles.includes('Secret draft'));
  assert.ok(!titles.includes('Old quiz'));
  assert.ok(!titles.includes('Sketch'));
  assert.equal(batch.assignments.find((item) => item.title === 'Reading check')?.due, null);
  assert.equal(batch.assignments.find((item) => item.title === 'Reading check')?.status, 'assigned');
  const oral = batch.assignments.find((item) => item.title === 'Oral report');
  assert.equal(oral?.status, 'turned_in');
  assert.notEqual(oral?.status, 'excused');
  assert.match(batch.notes.join(' '), /no excused field/);
  assert.equal(batch.assignments.find((item) => item.title === 'Poster for peers')?.dropped, true);
  assert.equal(batch.assignments.find((item) => item.title === 'Makeup drill')?.status, 'missing');
  assert.equal(batch.assignments.find((item) => item.title === 'Makeup drill')?.term, 'Q1');
  const grade = batch.grades.find((item) => item.courseName === 'Biology edges');
  assert.equal(grade?.percent, 87.78);
  assert.equal(grade?.term, 'Q2');
  assert.equal(batch.grades.find((item) => item.courseName === 'Study Skills'), undefined);
  assert.ok(batch.assignments.some((item) => item.title === 'Planner check'));
  assert.ok(!batch.students.some((student) => student.name === 'Guardian A'));
  assert.equal(weightToPercent(200000), 20);
  assert.equal(classroomDueInstant({ year: 2026, month: 11, day: 6 }, { minutes: 45 }), '2026-11-06T00:45:00Z');
});

test('Classroom student snapshot computes the weighted Q2 grade and ignores guardians', () => {
  const batch = parseClassroom(read('fixtures/classroom/student-b.json'));
  assert.equal(batch.students[0]?.name, 'Student B');
  assert.equal(batch.students[0]?.school, 'Northwind High');
  const biology = batch.grades.find((grade) => grade.courseName === 'Biology');
  const history = batch.grades.find((grade) => grade.courseName === 'World History');
  assert.equal(biology?.percent, 79);
  assert.equal(biology?.letter, 'C+');
  assert.equal(history?.percent, 90);
  assert.equal(history?.letter, 'A-');
  assert.equal(batch.assignments.find((item) => item.title === 'Quiz 3')?.status, 'missing');
  assert.equal(batch.assignments.find((item) => item.title === 'Enzyme poster')?.status, 'late');
  assert.equal(batch.assignments.find((item) => item.title === 'Reading check')?.due, null);
  assert.equal(batch.assignments.find((item) => item.title === 'Peer review')?.dropped, true);
  assert.equal(batch.assignments.find((item) => item.title === 'Safety quiz')?.term, 'Q1');
  assert.ok(!batch.assignments.some((item) => item.title === 'Unpublished lab' || item.title === 'Removed quiz'));
  assert.equal(batch.assignments.find((item) => item.title === 'Primary source notes')?.due, '2026-11-06');
  assert.ok(!batch.students.some((student) => /guardian/i.test(student.name)));
});

test('generic JSON and CSV, and a bad status is rejected', () => {
  const json = parseGeneric(read('fixtures/generic/advisory.json'));
  assert.equal(json.assignments[0]?.title, 'Conference form');
  assert.equal(json.grades[0]?.percent, 95);
  const csv = parseGeneric(read('fixtures/generic/club.csv'));
  assert.equal(csv.assignments[0]?.title, 'Kickoff, build day');
  assert.equal(csv.courses[0]?.name, 'Robotics');
  assert.throws(() => parseGeneric(read('fixtures/generic/bad-status.json')), /unknown status/);
  assert.equal(sniffSource(read('fixtures/generic/club.csv')), 'generic');
  assert.equal(sniffSource(read('fixtures/classroom/student-b.json')), 'google-classroom');
  assert.equal(sniffSource(read('fixtures/powerschool/home-2026-11-02.html')), 'powerschool');
});
