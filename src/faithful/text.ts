import { createHash } from 'node:crypto';

export function slug(value: string): string {
  const s = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'item';
}

export function collapse(value: string | null | undefined): string {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function shortHash(value: string): string {
  return sha256(value).slice(0, 16);
}

export function studentIdForName(name: string): string {
  return `stu:${slug(name)}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
