/**
 * Read-only Google Classroom sync.
 * Guardians do not get a scope that can read coursework. Use a student token
 * (classroom.*.me.readonly) or a teacher/admin token (classroom.*.students.readonly).
 * This module only issues GET requests.
 */

export interface ClassroomFetchOptions {
  token: string;
  fetchImpl?: typeof fetch;
  school?: string;
  studentName?: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

const ROOT = 'https://classroom.googleapis.com/v1';

export async function fetchClassroomSnapshot(options: ClassroomFetchOptions): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const courses = await listAll(fetchImpl, options.token, `${ROOT}/courses?courseStates=ACTIVE&pageSize=100`, 'courses');
  const courseWork: Record<string, unknown> = {};
  const studentSubmissions: Record<string, unknown> = {};
  const gradingPeriodSettings: Record<string, unknown> = {};
  for (const course of courses) {
    const id = String(course.id ?? '');
    if (!id) continue;
    courseWork[id] = {
      courseWork: await listAll(fetchImpl, options.token, `${ROOT}/courses/${id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100&orderBy=updateTime desc`, 'courseWork'),
    };
    studentSubmissions[id] = {
      studentSubmissions: await listAll(
        fetchImpl,
        options.token,
        `${ROOT}/courses/${id}/courseWork/-/studentSubmissions?pageSize=100`,
        'studentSubmissions',
      ),
    };
    gradingPeriodSettings[id] = await getOptional(fetchImpl, options.token, `${ROOT}/courses/${id}/gradingPeriodSettings`);
  }
  const profile = await getJson(fetchImpl, options.token, `${ROOT}/userProfiles/me`);
  const userId = String(profile.id ?? '');
  const name = options.studentName || readName(profile) || 'Student';
  const guardians = await getOptional(fetchImpl, options.token, `${ROOT}/userProfiles/${userId || 'me'}/guardians`);
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

async function listAll(fetchImpl: typeof fetch, token: string, firstUrl: string, key: string): Promise<JsonRecord[]> {
  const items: JsonRecord[] = [];
  let url: string | null = firstUrl;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    assertGet(url);
    const body = await getJson(fetchImpl, token, url);
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

async function getOptional(fetchImpl: typeof fetch, token: string, url: string): Promise<JsonRecord | null> {
  assertGet(url);
  const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(token) });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Classroom GET ${response.status} for ${redact(url)}`);
  return (await response.json()) as JsonRecord;
}

async function getJson(fetchImpl: typeof fetch, token: string, url: string): Promise<JsonRecord> {
  assertGet(url);
  const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(token) });
  if (!response.ok) throw new Error(`Classroom GET ${response.status} for ${redact(url)}`);
  return (await response.json()) as JsonRecord;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

function assertGet(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Classroom sync only uses https GET');
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
