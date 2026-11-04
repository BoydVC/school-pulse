/**
 * Read-only Google Classroom sync.
 * Guardians do not get a scope that can read coursework. Use a student token
 * (classroom.*.me.readonly) or a teacher/admin token (classroom.*.students.readonly).
 * This module only issues GET requests. A 401 refreshes once via onUnauthorized.
 */

import { authorizedGet, createSession, type AuthSession } from './session.js';

export interface ClassroomFetchOptions {
  token: string;
  fetchImpl?: typeof fetch;
  school?: string;
  studentName?: string;
  onUnauthorized?: () => Promise<string>;
}

interface JsonRecord {
  [key: string]: unknown;
}

const ROOT = 'https://classroom.googleapis.com/v1';

export async function fetchClassroomSnapshot(options: ClassroomFetchOptions): Promise<JsonRecord> {
  const session = createSession(options);
  const courses = await listAll(session, `${ROOT}/courses?courseStates=ACTIVE&pageSize=100`, 'courses');
  const courseWork: Record<string, unknown> = {};
  const studentSubmissions: Record<string, unknown> = {};
  const gradingPeriodSettings: Record<string, unknown> = {};
  for (const course of courses) {
    const id = String(course.id ?? '');
    if (!id) continue;
    courseWork[id] = {
      courseWork: await listAll(session, `${ROOT}/courses/${id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100&orderBy=updateTime desc`, 'courseWork'),
    };
    studentSubmissions[id] = {
      studentSubmissions: await listAll(
        session,
        `${ROOT}/courses/${id}/courseWork/-/studentSubmissions?pageSize=100`,
        'studentSubmissions',
      ),
    };
    gradingPeriodSettings[id] = await getOptional(session, `${ROOT}/courses/${id}/gradingPeriodSettings`);
  }
  const profile = await getJson(session, `${ROOT}/userProfiles/me`);
  const userId = String(profile.id ?? '');
  const name = options.studentName || readName(profile) || 'Student';
  const guardians = await getOptional(session, `${ROOT}/userProfiles/${userId || 'me'}/guardians`);
  return stripEmails({
    schoolPulse: {
      exportedAt: new Date().toISOString(),
      school: options.school ?? '',
      students: { [userId || 'me']: { name, school: options.school ?? '' } },
    },
    student: { userId: userId || 'me', fullName: name, school: options.school ?? '' },
    courses: { courses },
    courseWork,
    studentSubmissions,
    gradingPeriodSettings,
    guardians: guardians ?? { guardians: [] },
  });
}

async function listAll(session: AuthSession, firstUrl: string, key: string): Promise<JsonRecord[]> {
  const items: JsonRecord[] = [];
  let url: string | null = firstUrl;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    const body = await getJson(session, url);
    const page = body[key];
    if (Array.isArray(page)) items.push(...(page as JsonRecord[]));
    const tokenNext = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (!tokenNext) break;
    const next = new URL(firstUrl);
    next.searchParams.set('pageToken', tokenNext);
    url = next.toString();
  }
  return items;
}

async function getOptional(session: AuthSession, url: string): Promise<JsonRecord | null> {
  const response = await authorizedGet(session, url, 'application/json', 'Classroom');
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Classroom GET ${response.status} for ${redact(url)}`);
  return (await response.json()) as JsonRecord;
}

async function getJson(session: AuthSession, url: string): Promise<JsonRecord> {
  const response = await authorizedGet(session, url, 'application/json', 'Classroom');
  if (!response.ok) throw new Error(`Classroom GET ${response.status} for ${redact(url)}`);
  return (await response.json()) as JsonRecord;
}

function readName(profile: JsonRecord): string {
  const name = profile.name as { fullName?: string } | undefined;
  return name?.fullName ?? '';
}

function redact(url: string): string {
  return url.replace(/access_token=[^&]+/, 'access_token=redacted');
}

/** Keep emails out of the snapshot that gets written to disk. */
export function stripEmails(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value, (key, inner) => {
    if (/email/i.test(key)) return undefined;
    return inner as unknown;
  })) as JsonRecord;
}
