import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { packageRoot } from "../src/paths.ts";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function files(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "data" || entry === ".git") continue;
    const info = statSync(full);
    if (info.isDirectory()) found.push(...files(full));
    else if (/\.(ts|js|json|html|csv|md|css|yml|gif|png)$/.test(entry)) found.push(full);
  }
  return found;
}

test("tracked text uses synthetic households only", () => {
  const root = packageRoot();
  const hits: string[] = [];
  for (const file of files(root)) {
    if (file.endsWith(".gif") || file.endsWith(".png")) continue;
    const text = readFileSync(file, "utf8");
    const matches = text.match(EMAIL) ?? [];
    for (const match of matches) {
      if (!match.endsWith("@example.invalid")) hits.push(`${file}: ${match}`);
    }
  }
  assert.deepEqual(hits, []);
});
