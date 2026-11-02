#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { explainAdapter, formatFor, sourceFromInboxPath } from "./adapters/index.ts";
import { pullGoogleClassroom, pullOneNote, type LocalStudent } from "./adapters/pull.ts";
import { liveDocument } from "./demo/documents.ts";
import { seedDemo } from "./demo/seed.ts";
import { explainIngest, ingestText } from "./ingest/ingest.ts";
import { ensureInbox, readSnapshotFile, watchInbox } from "./ingest/watch.ts";
import { instantFromDate, isSource, type IsoInstant, type Source } from "./domain/index.ts";
import { packageRoot } from "./paths.ts";
import { startServer } from "./server/http.ts";
import { Store } from "./store/store.ts";

const HELP = `School Pulse

  school-pulse demo [--data dir] [--port 4173]
  school-pulse serve [--data dir] [--port 4173]
  school-pulse ingest <file> [--source name] [--data dir]
  school-pulse pull <google-classroom|onenote> [--data dir]

Data stays in SCHOOL_PULSE_DATA or ./data. Nothing is sent to a school unless you run pull, which only issues read requests.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const dataDir = resolve(flag(args, "--data") ?? process.env["SCHOOL_PULSE_DATA"] ?? "data");
  const port = Number(flag(args, "--port") ?? process.env["SCHOOL_PULSE_PORT"] ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
  if (command === "demo") {
    await runDemo(dataDir, port);
    return;
  }
  if (command === "serve") {
    await runServe(dataDir, port);
    return;
  }
  if (command === "ingest") {
    const file = args.find((arg) => !arg.startsWith("--") && arg !== "ingest");
    if (!file) throw new Error("ingest needs a file");
    const source = resolveSource(file, flag(args, "--source"));
    const store = openStore(dataDir);
    const now = instantFromDate(new Date());
    const result = await ingestText(store, source, readFileSync(file, "utf8"), basename(file), now);
    store.close();
    if (!result.ok) throw new Error(explainIngest(result.error));
    printOutcome(result.value.outcome === "unchanged" ? `${source} unchanged` : `${source} applied`, result.value.outcome === "applied" ? result.value.messages : []);
    return;
  }
  if (command === "pull") {
    const which = args[1];
    if (which !== "google-classroom" && which !== "onenote") throw new Error("pull needs google-classroom or onenote");
    await runPull(dataDir, which);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

async function runDemo(dataDir: string, port: number): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const store = openStore(dataDir);
  const existing = store.hasSource("powerschool");
  const now = instantFromDate(new Date());
  if (!existing) {
    const seeded = await seedDemo(store, now);
    const example = liveDocument(now);
    mkdirSync(join(dataDir, "examples"), { recursive: true });
    writeFileSync(join(dataDir, "examples", example.filename), example.text);
    console.log(`seeded ${seeded.students} students, ${seeded.assignments} assignments, ${seeded.sources} sources`);
  } else {
    console.log("using the household already stored in this data directory");
  }
  await serve(store, dataDir, port, now, join(dataDir, "examples", "powerschool-update.json"));
}

async function runServe(dataDir: string, port: number): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  await serve(openStore(dataDir), dataDir, port, instantFromDate(new Date()), null);
}

async function serve(store: Store, dataDir: string, port: number, seededAt: IsoInstant, example: string | null): Promise<void> {
  ensureInbox(dataDir);
  const server = await startServer({ store, port, publicDir: join(packageRoot(), "public") });
  const watcher = watchInbox(dataDir, (file, source) => {
    void server.ingest(source, readSnapshotFile(file), basename(file)).then((result) => {
      if ("error" in result) {
        console.error(`ingest ${basename(file)} failed: ${result.error}`);
        return;
      }
      if (result.outcome === "unchanged") {
        console.log(`${source} unchanged ${basename(file)}`);
        return;
      }
      console.log(`${source} applied ${basename(file)}`);
      for (const message of result.messages) console.log(`  ${message}`);
    });
  });
  console.log(`listening ${server.url}`);
  console.log(`data ${dataDir}`);
  if (example) console.log(`live drop: cp "${example}" "${join(dataDir, "inbox", "powerschool")}/"`);
  console.log("seed clock", seededAt);
  const stop = async () => {
    watcher.close();
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function runPull(dataDir: string, source: "google-classroom" | "onenote"): Promise<void> {
  const token = readToken(dataDir, source);
  const student = readStudent(dataDir, source);
  const now = instantFromDate(new Date());
  const pulled = source === "google-classroom"
    ? await pullGoogleClassroom({ accessToken: token, student: { ...student, userId: student.userId ?? student.sourceId }, now })
    : await pullOneNote({ accessToken: token, student, now });
  if (!pulled.ok) throw new Error(explainAdapter(pulled.error));
  const store = openStore(dataDir);
  const result = await ingestText(store, source, pulled.value.text, `${source}.json`, now);
  store.close();
  if (!result.ok) throw new Error(explainIngest(result.error));
  if (result.value.outcome === "unchanged") {
    console.log(`${source} unchanged`);
    return;
  }
  console.log(`${source} applied`);
  for (const message of result.value.messages) console.log(`  ${message}`);
}

function readToken(dataDir: string, source: Source): string {
  const env = source === "google-classroom" ? process.env["SCHOOL_PULSE_CLASSROOM_TOKEN"] : process.env["SCHOOL_PULSE_ONENOTE_TOKEN"];
  if (env && env.trim()) return env.trim();
  const file = join(dataDir, "secrets", source === "google-classroom" ? "google-classroom.token" : "onenote.token");
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    // fall through to the message
  }
  throw new Error(`missing ${source} token. Set the env var or put a token file in data/secrets/. The token is never written to the repo.`);
}

function readStudent(dataDir: string, source: "google-classroom" | "onenote"): LocalStudent & { userId?: string } {
  const file = join(dataDir, "students.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("copy config/students.example.json to data/students.json before pulling");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("students.json must be an object");
  const record = parsed as Record<string, unknown>;
  const entry = record[source === "google-classroom" ? "classroom" : "onenote"];
  if (typeof entry !== "object" || entry === null) throw new Error(`students.json is missing ${source}`);
  const student = entry as Record<string, unknown>;
  const householdKey = student["householdKey"];
  const displayName = student["displayName"];
  const sourceId = student["sourceId"] ?? student["userId"];
  if (typeof householdKey !== "string" || typeof displayName !== "string" || typeof sourceId !== "string") {
    throw new Error("student config needs householdKey, displayName, and sourceId");
  }
  return {
    sourceId,
    householdKey,
    displayName,
    schoolName: typeof student["schoolName"] === "string" ? student["schoolName"] : null,
    ...(typeof student["userId"] === "string" ? { userId: student["userId"] } : {}),
  };
}

function resolveSource(file: string, explicit: string | undefined): Source {
  if (explicit) {
    if (!isSource(explicit)) throw new Error(`unknown source ${explicit}`);
    return explicit;
  }
  const fromPath = sourceFromInboxPath(file);
  if (fromPath) return fromPath;
  const text = readFileSync(file, "utf8");
  const format = formatFor(file);
  if (format === "json") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && "courses" in parsed && "courseWork" in parsed) return "google-classroom";
      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { value?: unknown }).value)) return "onenote";
      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { students?: unknown }).students)) {
        const first = (parsed as { students: unknown[] }).students[0];
        if (typeof first === "object" && first !== null && "classes" in first) return "powerschool";
      }
    } catch {
      // the adapter will report the parse error
    }
  }
  if (format === "html" && text.includes("data-section-id")) return "powerschool";
  if (format === "html" && /Homework:/i.test(text)) return "onenote";
  if (format === "csv") return "generic";
  throw new Error("pass --source powerschool|onenote|google-classroom|generic");
}

function openStore(dataDir: string): Store {
  return new Store(join(dataDir, "school-pulse.sqlite"));
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function printOutcome(title: string, messages: readonly string[]): void {
  console.log(title);
  for (const message of messages) console.log(`  ${message}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
