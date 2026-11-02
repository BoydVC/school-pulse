import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Checked-in synthetic snapshots, copied in chronological order. */
export const DEMO_FILES: { folder: string; name: string; source: string }[] = [
  { folder: 'powerschool', name: '01-math-q1-2026-09-15.html', source: 'fixtures/powerschool/math-q1-2026-09-15.html' },
  { folder: 'powerschool', name: '02-math-q1-2026-10-20.html', source: 'fixtures/powerschool/math-q1-2026-10-20.html' },
  { folder: 'powerschool', name: '03-math-q2-2026-11-02.html', source: 'fixtures/powerschool/math-q2-2026-11-02.html' },
  { folder: 'powerschool', name: '04-science-q2-2026-11-02.html', source: 'fixtures/powerschool/science-q2-2026-11-02.html' },
  { folder: 'powerschool', name: '05-english-q2-2026-11-02.html', source: 'fixtures/powerschool/english-q2-2026-11-02.html' },
  { folder: 'powerschool', name: '06-home-2026-11-02.html', source: 'fixtures/powerschool/home-2026-11-02.html' },
  { folder: 'onenote', name: '07-science-homework.json', source: 'fixtures/onenote/science-homework.json' },
  { folder: 'google-classroom', name: '08-student-b.json', source: 'fixtures/classroom/student-b.json' },
  { folder: 'generic', name: '09-advisory.json', source: 'fixtures/generic/advisory.json' },
];

export function seedDemoInbox(inbox: string): string[] {
  const written: string[] = [];
  for (const file of DEMO_FILES) {
    const target = join(inbox, file.folder, file.name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, file.source), target);
    written.push(target);
  }
  return written;
}

export function repoRoot(): string {
  return ROOT;
}
