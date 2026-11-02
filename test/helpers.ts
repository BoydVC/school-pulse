import { readFileSync } from "node:fs";
import { join } from "node:path";
import { instant, type IsoInstant } from "../src/domain/index.ts";
import { packageRoot } from "../src/paths.ts";
import { Store } from "../src/store/store.ts";

export function fixture(name: string): string {
  return readFileSync(join(packageRoot(), "fixtures", name), "utf8");
}

export function fixedNow(): IsoInstant {
  const parsed = instant("2026-11-02T18:00:00.000Z");
  if (!parsed.ok) throw new Error("clock");
  return parsed.value;
}

export function memoryStore(): Store {
  return new Store(":memory:");
}
