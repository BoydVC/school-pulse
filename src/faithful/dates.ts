const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function isoDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISODate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) throw new Error(`Bad date: ${iso}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function addDays(iso: string, days: number): string {
  const date = parseISODate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDateUTC(date);
}

export function weekdayIndex(iso: string): number {
  return parseISODate(iso).getUTCDay();
}

export function weekdayShort(iso: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayIndex(iso)] ?? 'Day';
}

/** Monday–Sunday week containing `iso`, as UTC calendar dates. */
export function weekBounds(iso: string): { start: string; end: string } {
  const day = weekdayIndex(iso);
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDays(iso, mondayOffset);
  return { start, end: addDays(start, 6) };
}

export function formatPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

/** Local display scale. Classroom's API returns points, not letters. */
export function letterForPercent(percent: number): string {
  if (percent >= 97) return 'A+';
  if (percent >= 93) return 'A';
  if (percent >= 90) return 'A-';
  if (percent >= 87) return 'B+';
  if (percent >= 83) return 'B';
  if (percent >= 80) return 'B-';
  if (percent >= 77) return 'C+';
  if (percent >= 73) return 'C';
  if (percent >= 70) return 'C-';
  if (percent >= 67) return 'D+';
  if (percent >= 63) return 'D';
  if (percent >= 60) return 'D-';
  return 'F';
}

export function formatRelative(thenIso: string, now: Date): string {
  const then = new Date(thenIso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.round((now.getTime() - then) / 60000);
  if (mins < 1 && mins > -1) return 'just now';
  if (mins < 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function isStale(thenIso: string, now: Date, staleHours: number): boolean {
  const then = new Date(thenIso).getTime();
  if (Number.isNaN(then)) return true;
  return now.getTime() - then >= staleHours * 3600 * 1000;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function weekdayIndexFromName(name: string): number | null {
  const map: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  return map[name] ?? null;
}

function nextWeekdayOnOrAfter(refIso: string, weekday: number): string {
  const current = weekdayIndex(refIso);
  const delta = (weekday - current + 7) % 7;
  return addDays(refIso, delta);
}

/**
 * Parse a due date out of portal text.
 * Returns a calendar date. Weekday-only phrases ("Due Fri") resolve against `refIso`.
 */
export function parseLooseDate(raw: string | null | undefined, refIso?: string | null): string | null {
  if (!raw) return null;
  let text = raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === '--' || text === '—' || text === '-') return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  text = text.replace(/^due(?:\s+date)?\s*[:\-]?\s*/i, '').trim();

  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (mdy) {
    const year = mdy[3]!.length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    return ymd(year, Number(mdy[1]), Number(mdy[2]));
  }

  const monthDaySlash = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (monthDaySlash && refIso) {
    return ymd(Number(refIso.slice(0, 4)), Number(monthDaySlash[1]), Number(monthDaySlash[2]));
  }

  const long = /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s*(\d{4})/.exec(text);
  if (long) {
    const month = MONTHS[long[1]!.toLowerCase()];
    if (month) return ymd(Number(long[3]), month, Number(long[2]));
  }

  const dmy = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2]!.toLowerCase()];
    if (month) return ymd(Number(dmy[3]), month, Number(dmy[1]));
  }

  const monthDay = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (monthDay && refIso) {
    const month = MONTHS[monthDay[1]!.toLowerCase()];
    if (month) return ymd(Number(refIso.slice(0, 4)), month, Number(monthDay[2]));
  }

  const weekday = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i.exec(text);
  if (weekday && refIso && !long && !mdy) {
    const index = weekdayIndexFromName(weekday[1]!.toLowerCase());
    if (index !== null) return nextWeekdayOnOrAfter(refIso.slice(0, 10), index);
  }

  const embedded = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (embedded?.[1]) return embedded[1];

  const embeddedMdy = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (embeddedMdy) return ymd(Number(embeddedMdy[3]), Number(embeddedMdy[1]), Number(embeddedMdy[2]));

  return null;
}

export function termRank(term: string | null | undefined): number {
  if (!term) return 0;
  const match = /^(Q|S|T|F|Y)(\d)$/i.exec(term.trim());
  if (!match) return 50;
  const kind = match[1]!.toUpperCase();
  const n = Number(match[2]);
  const base = kind === 'Q' ? 10 : kind === 'T' ? 20 : kind === 'S' ? 30 : kind === 'F' ? 40 : 50;
  return base + n;
}

export function looksLikeTerm(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const code = /^(Q[1-4]|S[1-2]|Y1|T[1-3]|F[1-2])$/i.exec(trimmed);
  if (code) return code[1]!.toUpperCase();
  const term = /^Term\s*([1-4])$/i.exec(trimmed);
  if (term) return `Q${term[1]}`;
  return null;
}
