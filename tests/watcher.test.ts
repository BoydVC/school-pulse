import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startWatcher } from "../src/ingest/watch.js";
import { listAssignments, openDatabase } from "../src/store/db.js";

test("a file dropped in the inbox is ingested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "school-pulse-"));
  const db = openDatabase(join(dir, "school-pulse.sqlite"));
  const watcher = startWatcher({ dataDir: dir, db });
  try {
    writeFileSync(
      join(dir, "inbox", "generic", "drop.json"),
      JSON.stringify({
        students: [{ sourceId: "stu-a", name: "Student A" }],
        courses: [{ sourceId: "math", studentSourceId: "stu-a", name: "Math" }],
        assignments: [{ sourceId: "a1", studentSourceId: "stu-a", courseSourceId: "math", title: "Problem set 12", status: "assigned" }],
      }),
    );
    const deadline = Date.now() + 4000;
    while (listAssignments(db).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(listAssignments(db)[0]?.title, "Problem set 12");
  } finally {
    watcher.close();
  }
});
