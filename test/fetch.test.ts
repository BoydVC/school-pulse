import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchClassroomSnapshot } from '../src/fetch/classroom.js';
import { fetchOneNoteSnapshot } from '../src/fetch/onenote.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Classroom sync only GETs and does not keep email addresses', async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    methods.push(method);
    const href = String(url);
    assert.equal(method, 'GET');
    if (href.includes('pageToken=next') && href.includes('/courses?')) return json({ courses: [{ id: '900000000102', name: 'World History', courseState: 'ACTIVE' }] });
    if (href.includes('/courses?')) return json({ courses: [{ id: '900000000101', name: 'Biology', courseState: 'ACTIVE' }], nextPageToken: 'next' });
    if (href.includes('/courseWork')) return json({ courseWork: [] });
    if (href.includes('/studentSubmissions')) return json({ studentSubmissions: [] });
    if (href.includes('gradingPeriodSettings')) return json({ error: 'not found' }, 404);
    if (href.endsWith('/userProfiles/me')) return json({ id: '900000000001', name: { fullName: 'Student B' }, emailAddress: 'student.b@example.invalid' });
    if (href.includes('/guardians')) return json({ error: 'forbidden' }, 403);
    return json({});
  };
  const snapshot = await fetchClassroomSnapshot({ token: 'test-token', fetchImpl, school: 'Northwind High' });
  assert.ok(methods.every((method) => method === 'GET'));
  assert.equal(methods.some((method) => method !== 'GET'), false);
  const encoded = JSON.stringify(snapshot);
  assert.equal(encoded.includes('email'), false);
  assert.equal(encoded.includes('example.invalid'), false);
  const student = snapshot.student as { fullName?: string; school?: string };
  assert.equal(student.fullName, 'Student B');
  assert.equal(student.school, 'Northwind High');
  const courses = (snapshot.courses as { courses: { id: string }[] }).courses;
  assert.deepEqual(courses.map((course) => course.id), ['900000000101', '900000000102']);
});

test('OneNote sync only GETs homework section page content', async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    methods.push(init?.method ?? 'GET');
    const href = String(url);
    assert.equal(init?.method ?? 'GET', 'GET');
    if (href.includes('/notebooks?')) {
      return json({
        value: [{
          displayName: 'Science',
          sections: [],
          sectionGroups: [{
            displayName: 'Student A',
            sections: [{ id: 'sec-hw', displayName: 'Homework' }, { id: 'sec-notes', displayName: 'Class Notes' }],
          }],
        }],
      });
    }
    if (href.includes('/sections/sec-hw/pages')) {
      return json({
        value: [{
          id: 'page-1',
          title: 'Week',
          contentUrl: 'https://graph.microsoft.com/v1.0/me/onenote/pages/page-1/content',
          createdDateTime: '2026-11-01T00:00:00Z',
        }],
      });
    }
    if (href.endsWith('/content')) return new Response('<html><body><p data-tag="to-do">Read</p></body></html>', { status: 200 });
    return json({ value: [] });
  };
  const snapshot = await fetchOneNoteSnapshot({ token: 'graph-token', fetchImpl, school: 'Pinecrest Middle', studentName: 'Student A' });
  assert.ok(methods.every((method) => method === 'GET'));
  const pages = snapshot.value as { content?: string }[];
  assert.equal(pages.length, 1);
  assert.match(pages[0]?.content ?? '', /data-tag="to-do"/);
});
