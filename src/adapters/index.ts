import { AdapterError, isSource, type ParsedBatch, type Source } from '../model.js';
import { parseClassroom } from './classroom.js';
import { parseGeneric } from './generic.js';
import { parseOneNote } from './onenote.js';
import { parsePowerSchool } from './powerschool.js';

export interface ParseOptions {
  now?: string;
  /** Hint from the inbox folder name. Content sniffing still wins when it is sure. */
  sourceHint?: Source | null;
}

export function parseSnapshot(input: string, options?: ParseOptions): ParsedBatch {
  const source = sniffSource(input) ?? options?.sourceHint ?? null;
  if (!source) {
    throw new AdapterError('Could not tell which school system this file came from', 'unknown');
  }
  if (source === 'powerschool') return parsePowerSchool(input, options);
  if (source === 'onenote') return parseOneNote(input, options);
  if (source === 'google-classroom') return parseClassroom(input, options);
  return parseGeneric(input, options);
}

export function sniffSource(input: string): Source | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      if (json.courseWork || json.studentSubmissions || (json.courses && json.schoolPulse)) return 'google-classroom';
      const context = typeof json['@odata.context'] === 'string' ? json['@odata.context'] : '';
      if (context.includes('onenote') || (json.schoolPulse && Array.isArray(json.value))) return 'onenote';
      if (Array.isArray(json.value) && json.value.some((page) => page && typeof page === 'object' && 'contentUrl' in (page as object))) {
        return 'onenote';
      }
      if (json.pages && (json.format === 'powerschool-scores-html' || json.student)) return 'powerschool';
      if (json.students || json.assignments || json.courses) {
        if (json.source === 'generic' || json.students) return 'generic';
      }
      if (typeof json.source === 'string' && isSource(json.source)) return json.source;
    } catch {
      return null;
    }
  }
  if (/<html|<table|<div/i.test(trimmed)) {
    if (/data-tag=|onenote/i.test(trimmed) && !/linkDescList|quickLookup|name="fg"/i.test(trimmed)) return 'onenote';
    if (/linkDescList|quickLookup|name="fg"|Class Score Detail|icon_missing|Due Date/i.test(trimmed)) return 'powerschool';
    if (/school-pulse-student/i.test(trimmed) && /data-tag/i.test(trimmed)) return 'onenote';
  }
  const header = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (/^student\b/i.test(header) && /\bcourse\b/i.test(header)) return 'generic';
  return null;
}

export function sourceFromFolder(name: string): Source | null {
  const key = name.toLowerCase();
  if (key === 'classroom' || key === 'google-classroom') return 'google-classroom';
  if (key === 'powerschool' || key === 'ps') return 'powerschool';
  if (key === 'onenote' || key === 'one-note') return 'onenote';
  if (key === 'generic' || key === 'csv' || key === 'json') return 'generic';
  return isSource(key) ? key : null;
}
