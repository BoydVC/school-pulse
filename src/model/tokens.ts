import { addDays, endOfDay, startOfDay } from "./dates.js";

const TOKEN = /\{\{SP:([A-Z_]+)(?::(-?\d+))?\}\}/g;

export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

export function expandDemoTokens(input: string, now: Date): string {
  return input.replace(TOKEN, (full, name: string, num: string | undefined) => {
    const count = num === undefined ? 0 : Number(num);
    if (name === "NOW") return now.toISOString();
    if (name === "TODAY") return endOfDay(now).toISOString();
    if (name === "TOMORROW") return endOfDay(addDays(now, 1)).toISOString();
    if (name === "YESTERDAY") return endOfDay(addDays(now, -1)).toISOString();
    if (name === "FRIDAY") {
      const friday = startOfDay(now);
      const delta = (5 - friday.getDay() + 7) % 7;
      friday.setDate(friday.getDate() + delta);
      return endOfDay(friday).toISOString();
    }
    if (name === "PLUS_DAYS") return endOfDay(addDays(now, count)).toISOString();
    if (name === "MINUS_DAYS") return endOfDay(addDays(now, -count)).toISOString();
    if (name === "MINUS_HOURS") return new Date(now.getTime() - count * 3_600_000).toISOString();
    if (name === "MINUS_MIN") return new Date(now.getTime() - count * 60_000).toISOString();
    return full;
  });
}
