import type { SQLOutputValue } from "node:sqlite";

export type SqlRow = Record<string, SQLOutputValue>;

export function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`expected text in ${key}`);
  return value;
}

export function textOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`expected text in ${key}`);
  return value;
}

export function numberOrNull(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`expected number in ${key}`);
  return value;
}
