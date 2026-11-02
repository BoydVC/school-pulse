import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/util/root.js";

export function fixedNow(): Date {
  return new Date(2026, 10, 2, 17, 30, 0, 0);
}

export function fixture(name: string): string {
  return readFileSync(join(repoRoot(), "fixtures", name), "utf8");
}
