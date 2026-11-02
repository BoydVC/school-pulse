/**
 * Read-only Microsoft Graph sync for class-notebook homework sections.
 * Delegated scope Notes.Read. Never PATCH or POST page content.
 * A 401 refreshes once via onUnauthorized.
 */

import { authorizedGet, createSession, type AuthSession } from './session.js';

export interface OneNoteFetchOptions {
  token: string;
  fetchImpl?: typeof fetch;
  school?: string;
  studentName?: string;
  sectionNames?: string[];
  onUnauthorized?: () => Promise<string>;
}

interface JsonRecord {
  [key: string]: unknown;
}

const ROOT = 'https://graph.microsoft.com/v1.0/me/onenote';
const DEFAULT_SECTIONS = ['homework', 'quizzes'];

export async function fetchOneNoteSnapshot(options: OneNoteFetchOptions): Promise<JsonRecord> {
  const session = createSession(options);
  const wanted = new Set((options.sectionNames ?? DEFAULT_SECTIONS).map((name) => name.toLowerCase()));
  const notebooks = await getJson(session, `${ROOT}/notebooks?$expand=sections,sectionGroups($expand=sections,sectionGroups($expand=sections))&$top=50`);
  const sections = collectSections(notebooks.value, wanted);
  const pages: JsonRecord[] = [];
  for (const section of sections) {
    const listed = await getJson(
      session,
      `${ROOT}/sections/${section.id}/pages?$expand=parentSection,parentNotebook&$top=50&$orderby=createdDateTime`,
    );
    const values = Array.isArray(listed.value) ? listed.value as JsonRecord[] : [];
    for (const page of values) {
      const contentUrl = typeof page.contentUrl === 'string' ? page.contentUrl : '';
      if (!contentUrl) continue;
      const html = await getText(session, contentUrl);
      pages.push({ ...page, content: html, parentSectionGroup: section.group ?? null });
    }
  }
  return {
    schoolPulse: {
      exportedAt: new Date().toISOString(),
      school: options.school ?? '',
      student: options.studentName ?? '',
    },
    '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('me')/onenote/pages",
    value: pages,
  };
}

interface SectionRef {
  id: string;
  group: JsonRecord | null;
}

function collectSections(value: unknown, wanted: Set<string>): SectionRef[] {
  const found: SectionRef[] = [];
  const visitNotebook = (notebook: JsonRecord) => {
    takeSections(notebook.sections, null, wanted, found);
    const groups = Array.isArray(notebook.sectionGroups) ? notebook.sectionGroups as JsonRecord[] : [];
    for (const group of groups) visitGroup(group);
  };
  const visitGroup = (group: JsonRecord) => {
    takeSections(group.sections, group, wanted, found);
    const nested = Array.isArray(group.sectionGroups) ? group.sectionGroups as JsonRecord[] : [];
    for (const child of nested) visitGroup(child);
  };
  const notebooks = Array.isArray(value) ? value as JsonRecord[] : [];
  for (const notebook of notebooks) visitNotebook(notebook);
  return found;
}

function takeSections(value: unknown, group: JsonRecord | null, wanted: Set<string>, found: SectionRef[]): void {
  const sections = Array.isArray(value) ? value as JsonRecord[] : [];
  for (const section of sections) {
    const name = String(section.displayName ?? section.name ?? '').toLowerCase();
    const id = String(section.id ?? '');
    if (id && wanted.has(name)) found.push({ id, group });
  }
}

async function getJson(session: AuthSession, url: string): Promise<JsonRecord> {
  const response = await authorizedGet(session, url, 'application/json', 'Graph');
  if (!response.ok) throw new Error(`Graph GET ${response.status}`);
  return (await response.json()) as JsonRecord;
}

async function getText(session: AuthSession, url: string): Promise<string> {
  const response = await authorizedGet(session, url, 'text/html', 'Graph');
  if (!response.ok) throw new Error(`Graph GET content ${response.status}`);
  return response.text();
}
