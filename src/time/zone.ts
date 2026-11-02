/** Household calendar. Day and week boundaries use this zone, never the host's UTC clock. */
export const DEFAULT_TIMEZONE = "America/New_York";

export interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday, matching Date#getDay. */
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function activeTimezone(): string {
  const configured = process.env.SCHOOL_PULSE_TZ?.trim() || process.env.SCHOOL_PULSE_TIMEZONE?.trim();
  if (configured && isTimeZone(configured)) return configured;
  return DEFAULT_TIMEZONE;
}

export function zonedParts(date: Date, timeZone = activeTimezone()): CivilTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: WEEKDAY[read("weekday")] ?? 0,
  };
}

export function civilDate(date: Date, timeZone = activeTimezone()): string {
  const parts = zonedParts(date, timeZone);
  return formatCivil(parts.year, parts.month, parts.day);
}

/** A YYYY-MM-DD string is already a civil date. An instant is converted in the household zone. */
export function civilDateFromIso(iso: string, timeZone = activeTimezone()): string {
  const text = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return civilDate(parsed, timeZone);
}

export function formatCivil(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Offset of `timeZone` at `date`: local civil clock minus UTC, in milliseconds. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

export function zonedTimeToUtc(
  civil: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone = activeTimezone(),
): Date {
  const guess = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  let instant = guess;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    instant = guess - timeZoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

export function endOfCivilDate(isoDay: string, timeZone = activeTimezone()): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`Not a civil date: ${isoDay}`);
  return zonedTimeToUtc(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 23, minute: 59, second: 0 },
    timeZone,
  );
}
