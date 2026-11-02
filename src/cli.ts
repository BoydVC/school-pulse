import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchClassroomSnapshot } from './fetch/classroom.js';
import { fetchOneNoteSnapshot } from './fetch/onenote.js';
import { ingestFile, ingestInbox } from './ingest.js';
import { dataDirFrom } from './paths.js';
import { seedDemoInbox } from './demo.js';
import { startServer } from './server.js';
import { openStore } from './store.js';

interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else flags[key] = true;
    } else positionals.push(token);
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function help(): void {
  console.log(`School Pulse

  school-pulse demo [--port 4317] [--data ./data]
  school-pulse serve [--port 4317] [--data ./data]
  school-pulse ingest <file> [--data ./data]
  school-pulse sync [--data ./data]

Read-only. Real student data stays in the data directory and is never committed.
Demo data is synthetic (Student A, Student B, Pinecrest Middle, Northwind High).`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags.help) {
    help();
    return;
  }
  const data = dataDirFrom(typeof args.flags.data === 'string' ? args.flags.data : null);
  const inbox = join(data, 'inbox');
  mkdirSync(data, { recursive: true });
  const store = openStore(join(data, 'school-pulse.sqlite'));
  const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : 4317;

  if (args.command === 'ingest') {
    const file = args.positionals[0];
    if (!file) {
      console.error('Usage: school-pulse ingest <file>');
      process.exitCode = 1;
      return;
    }
    const report = ingestFile(store, file);
    console.log(JSON.stringify(report, null, 2));
    if (report.error) process.exitCode = 1;
    store.close();
    return;
  }

  if (args.command === 'sync') {
    await sync(data, inbox, store);
    store.close();
    return;
  }

  if (args.command === 'demo') {
    seedDemoInbox(inbox);
  }

  if (args.command === 'demo' || args.command === 'serve') {
    const running = await startServer({ store, inbox, port, host: '127.0.0.1' });
    console.log(`School Pulse is local at ${running.url}`);
    if (args.command === 'demo') {
      console.log('Synthetic household: Student A (Pinecrest Middle) and Student B (Northwind High).');
      console.log(`Drop a file in ${join(inbox, 'onenote')} to see a live update.`);
      console.log(`Try: cp fixtures/demo/science-lab.json ${join(inbox, 'onenote')}/`);
    }
    const shutdown = async () => {
      await running.close();
      store.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return;
  }

  help();
  store.close();
  process.exitCode = 1;
}

async function sync(data: string, inbox: string, store: ReturnType<typeof openStore>): Promise<void> {
  mkdirSync(inbox, { recursive: true });
  const config = readConfig(data);
  let wrote = false;
  const classroomToken = token(data, 'google-classroom.json', 'SCHOOL_PULSE_CLASSROOM_TOKEN');
  if (classroomToken) {
    const snapshot = await fetchClassroomSnapshot({
      token: classroomToken,
      school: config.school,
      studentName: config.studentName,
    });
    const file = join(inbox, 'google-classroom', `sync-${Date.now()}.json`);
    mkdirSync(join(inbox, 'google-classroom'), { recursive: true });
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
    console.log(JSON.stringify(ingestFile(store, file), null, 2));
    wrote = true;
  }
  const graphToken = token(data, 'microsoft-graph.json', 'SCHOOL_PULSE_GRAPH_TOKEN');
  if (graphToken) {
    const snapshot = await fetchOneNoteSnapshot({
      token: graphToken,
      school: config.school,
      studentName: config.studentName,
    });
    const file = join(inbox, 'onenote', `sync-${Date.now()}.json`);
    mkdirSync(join(inbox, 'onenote'), { recursive: true });
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
    console.log(JSON.stringify(ingestFile(store, file), null, 2));
    wrote = true;
  }
  if (!wrote) {
    console.log('No tokens configured. See docs/ADAPTERS.md. PowerSchool is snapshot-only: save the portal page into data/inbox/powerschool/.');
  }
  ingestInbox(store, inbox);
}

function token(data: string, file: string, envName: string): string | null {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const path = join(data, 'tokens', file);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { access_token?: string };
  return parsed.access_token ?? null;
}

function readConfig(data: string): { school?: string; studentName?: string } {
  const path = join(data, 'config.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as { school?: string; studentName?: string };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
