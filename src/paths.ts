import { resolve } from 'node:path';

export function dataDirFrom(explicit?: string | null): string {
  if (explicit) return resolve(explicit);
  if (process.env.SCHOOL_PULSE_DATA) return resolve(process.env.SCHOOL_PULSE_DATA);
  return resolve(process.cwd(), 'data');
}

export function staleHours(): number {
  const raw = process.env.SCHOOL_PULSE_STALE_HOURS;
  const parsed = raw ? Number(raw) : 36;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 36;
}
