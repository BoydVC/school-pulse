#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = resolve(root, 'dist/cli.js');
const source = resolve(root, 'src/cli.ts');

if (existsSync(compiled)) {
  await import(compiled);
} else if (existsSync(source)) {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', source, ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  console.error('school-pulse is not built. Run npm install && npm run build.');
  process.exit(1);
}
