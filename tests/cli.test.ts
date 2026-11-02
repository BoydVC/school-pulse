import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../src/util/root.js";

test("school-pulse ingest is idempotent from the CLI", () => {
  const root = repoRoot();
  const data = mkdtempSync(join(tmpdir(), "school-pulse-cli-"));
  const cli = join(root, "dist", "src", "cli.js");
  const file = join(root, "fixtures", "generic", "snapshot.json");
  const first = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "ingest", file, "--data", data], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /New: Problem set 12/);
  const second = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "ingest", file, "--data", data], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /No changes/);
});
