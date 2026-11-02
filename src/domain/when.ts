import { err, ok, type Result } from "./result.ts";
import { instant, instantFromDate, type DomainError, type IsoInstant } from "./brand.ts";

const MONTHS: Readonly<Record<string, number>> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

function endOfUtcDay(year: number, month: number, day: number): Result<IsoInstant, DomainError> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return err({ kind: "bad_due", value: `${year}-${month}-${day}` });
  }
  const date = new Date(Date.UTC(year, month, day, 23, 59, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return err({ kind: "bad_due", value: `${year}-${month + 1}-${day}` });
  }
  return ok(instantFromDate(date));
}

export function parseDue(raw: string, now: IsoInstant): Result<IsoInstant, DomainError> {
  const text = raw.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (text.length === 0) return err({ kind: "bad_due", value: raw });
  const asInstant = instant(text);
  if (asInstant.ok) return asInstant;

  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDay?.[1] && isoDay[2] && isoDay[3]) {
    return endOfUtcDay(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]));
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash?.[1] && slash[2] && slash[3]) {
    return endOfUtcDay(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));
  }

  const long = /^(?:[A-Za-z]+ )?(?:the )?([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/.exec(text);
  if (long?.[1] && long[2] && long[3]) {
    const month = MONTHS[long[1].toLowerCase()];
    if (month === undefined) return err({ kind: "bad_due", value: raw });
    return endOfUtcDay(Number(long[3]), month, Number(long[2]));
  }

  const weekday = WEEKDAYS[text.toLowerCase()];
  if (weekday !== undefined) {
    const current = new Date(now);
    const delta = (weekday - current.getUTCDay() + 7) % 7;
    return endOfUtcDay(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + delta);
  }

  return err({ kind: "bad_due", value: raw });
}

export function addUtcDays(now: IsoInstant, days: number, hour = 23, minute = 59): IsoInstant {
  const current = new Date(now);
  return instantFromDate(
    new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + days, hour, minute, 0)),
  );
}

export function utcDay(value: IsoInstant): string {
  return value.slice(0, 10);
}

export function weekdayShort(value: IsoInstant | null): string | null {
  if (value === null) return null;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return names[new Date(value).getUTCDay()] ?? null;
}

export type WeekRange = { readonly start: IsoInstant; readonly end: IsoInstant };

export function utcWeek(now: IsoInstant): WeekRange {
  const current = new Date(now);
  const mondayOffset = (current.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - mondayOffset));
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start: instantFromDate(start), end: instantFromDate(end) };
}

export function inRange(value: IsoInstant | null, range: WeekRange): boolean {
  if (value === null) return false;
  return value >= range.start && value < range.end;
}

export function ageLabel(then: IsoInstant, now: IsoInstant): string {
  const elapsed = Date.parse(now) - Date.parse(then);
  if (!Number.isFinite(elapsed) || elapsed < 45_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
  return `${Math.round(elapsed / 86_400_000)}d ago`;
}

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isStale(then: IsoInstant | null, now: IsoInstant): boolean {
  if (then === null) return true;
  return Date.parse(now) - Date.parse(then) > STALE_AFTER_MS;
}
