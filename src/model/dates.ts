import { activeTimezone, endOfCivilDate, zonedParts, zonedTimeToUtc } from "../time/zone.js";

export function startOfDay(date: Date, timeZone = activeTimezone()): Date {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function endOfDay(date: Date, timeZone = activeTimezone()): Date {
  const parts = zonedParts(date, timeZone);
  const end = zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 23, minute: 59, second: 59 }, timeZone);
  return new Date(end.getTime() + 999);
}

export function addDays(date: Date, days: number, timeZone = activeTimezone()): Date {
  const parts = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedTimeToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    },
    timeZone,
  );
}

export function isSameDay(a: Date, b: Date, timeZone = activeTimezone()): boolean {
  const left = zonedParts(a, timeZone);
  const right = zonedParts(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function startOfWeek(date: Date, timeZone = activeTimezone()): Date {
  const start = startOfDay(date, timeZone);
  const weekday = zonedParts(start, timeZone).weekday;
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return addDays(start, diff, timeZone);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export function parseLooseDate(input: string, now: Date, timeZone = activeTimezone()): Date | null {
  const text = input.trim().replace(/[.,]+$/g, "");
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "today" || lower === "tonight") return endOfDay(now, timeZone);
  if (lower === "tomorrow") return endOfDay(addDays(now, 1, timeZone), timeZone);
  if (lower === "yesterday") return endOfDay(addDays(now, -1, timeZone), timeZone);

  const weekday = WEEKDAYS.indexOf(lower);
  if (weekday >= 0) {
    const today = zonedParts(now, timeZone).weekday;
    const delta = (weekday - today + 7) % 7;
    return endOfDay(addDays(now, delta, timeZone), timeZone);
  }

  const prefixed = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+(.+)$/);
  if (prefixed?.[2]) {
    const rest = parseLooseDate(prefixed[2], now, timeZone);
    if (rest) return rest;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return endOfCivilDate(text, timeZone);

  if (/^\d{4}-\d{2}-\d{2}t/i.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash?.[1] && slash[2] && slash[3]) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    return endOfCivilDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, timeZone);
  }

  const named = lower.match(/^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (named?.[1] && named[2] && MONTHS[named[1]] !== undefined) {
    const year = named[3] ? Number(named[3]) : zonedParts(now, timeZone).year;
    const month = MONTHS[named[1]]! + 1;
    const day = Number(named[2]);
    return endOfCivilDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, timeZone);
  }

  return null;
}

export function formatDuePhrase(dueIso: string | null, now: Date, timeZone = activeTimezone()): string | null {
  if (!dueIso) return null;
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return null;
  if (isSameDay(due, now, timeZone)) return "tonight";
  if (isSameDay(due, addDays(now, 1, timeZone), timeZone)) return "tomorrow";
  const horizon = endOfDay(addDays(now, 6, timeZone), timeZone).getTime();
  if (due.getTime() >= startOfDay(now, timeZone).getTime() && due.getTime() <= horizon) {
    return due.toLocaleDateString("en-US", { weekday: "short", timeZone });
  }
  return due.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

export function daysLate(dueIso: string, now: Date, timeZone = activeTimezone()): number {
  const due = startOfDay(new Date(dueIso), timeZone).getTime();
  const today = startOfDay(now, timeZone).getTime();
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

export function formatDueLabel(dueIso: string | null, status: string, now: Date, timeZone = activeTimezone()): string {
  if (!dueIso) return "No due date";
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return "No due date";
  if (status === "assigned" && due.getTime() < startOfDay(now, timeZone).getTime()) return "Past due · not marked";
  if (status === "missing" || status === "late") {
    if (isSameDay(due, now, timeZone)) return "Due tonight";
    const days = daysLate(dueIso, now, timeZone);
    if (days <= 1) return "1 day late";
    return `${days} days late`;
  }
  const phrase = formatDuePhrase(dueIso, now, timeZone);
  if (phrase === "tonight") return "Due tonight";
  if (phrase === "tomorrow") return "Due tomorrow";
  if (phrase) return `Due ${phrase}`;
  return "Due";
}

export function formatWhen(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  if (ms < 45_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.max(1, Math.round(ms / 86_400_000));
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function dayHeading(date: Date, now: Date, timeZone = activeTimezone()): string {
  if (isSameDay(date, now, timeZone)) return "Today";
  if (isSameDay(date, addDays(now, 1, timeZone), timeZone)) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone });
}

export function clockParts(now: Date, timeZone = activeTimezone()): { weekday: string; date: string; time: string } {
  return {
    weekday: now.toLocaleDateString("en-US", { weekday: "long", timeZone }),
    date: now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }),
    time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }),
  };
}
