export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function endOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(23, 59, 0, 0);
  return next;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfWeek(date: Date): Date {
  const next = startOfDay(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
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

export function parseLooseDate(input: string, now: Date): Date | null {
  const text = input.trim().replace(/[.,]+$/g, "");
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "today" || lower === "tonight") return endOfDay(now);
  if (lower === "tomorrow") return endOfDay(addDays(now, 1));
  if (lower === "yesterday") return endOfDay(addDays(now, -1));

  const weekday = WEEKDAYS.indexOf(lower);
  if (weekday >= 0) {
    const next = startOfDay(now);
    const delta = (weekday - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
    return endOfDay(next);
  }

  const prefixed = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+(.+)$/);
  if (prefixed?.[2]) {
    const rest = parseLooseDate(prefixed[2], now);
    if (rest) return rest;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parts = text.split("-").map(Number);
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    if (!year || !month || !day) return null;
    return endOfDay(new Date(year, month - 1, day));
  }

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
    return endOfDay(new Date(year, month - 1, day));
  }

  const named = lower.match(/^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (named?.[1] && named[2] && MONTHS[named[1]] !== undefined) {
    const year = named[3] ? Number(named[3]) : now.getFullYear();
    return endOfDay(new Date(year, MONTHS[named[1]]!, Number(named[2])));
  }

  return null;
}

export function formatDuePhrase(dueIso: string | null, now: Date): string | null {
  if (!dueIso) return null;
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return null;
  if (isSameDay(due, now)) return "tonight";
  if (isSameDay(due, addDays(now, 1))) return "tomorrow";
  const horizon = endOfDay(addDays(now, 6)).getTime();
  if (due.getTime() >= startOfDay(now).getTime() && due.getTime() <= horizon) {
    return due.toLocaleDateString("en-US", { weekday: "short" });
  }
  return due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function daysLate(dueIso: string, now: Date): number {
  const due = startOfDay(new Date(dueIso)).getTime();
  const today = startOfDay(now).getTime();
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

export function formatDueLabel(dueIso: string | null, status: string, now: Date): string {
  if (!dueIso) return "No due date";
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return "No due date";
  if (status === "missing" || status === "late") {
    if (isSameDay(due, now)) return "Due tonight";
    const days = daysLate(dueIso, now);
    if (days <= 1) return "1 day late";
    return `${days} days late`;
  }
  const phrase = formatDuePhrase(dueIso, now);
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

export function dayHeading(date: Date, now: Date): string {
  if (isSameDay(date, now)) return "Today";
  if (isSameDay(date, addDays(now, 1))) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long" });
}

export function clockParts(now: Date): { weekday: string; date: string; time: string } {
  return {
    weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
    date: now.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  };
}
