import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "attendance.ts"),
  "utf8"
);

test("attendance report loading batches dual roster .in filters under PostgREST URL limits", () => {
  assert.match(source, /loadPostgrestInFilterBatches/);
  assert.match(source, /ROSTER_PLAN_IN_BATCH_SIZE = 25/);
  assert.match(source, /ROSTER_WORKER_IN_BATCH_SIZE = 80/);
  assert.match(source, /loadWeeklyRosterEntriesForWorkers/);
  assert.match(source, /readAllRows/);
  assert.ok(
    source.includes('.in("plan_id", planChunk)') && source.includes('.in("worker_id", workerChunk)'),
    "weekly roster entries must batch both plan and worker filters"
  );
});

test("attendance page only labels real schema failures as database setup needed", () => {
  const page = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../app/attendance/page.tsx"),
    "utf8"
  );
  assert.match(page, /Unable to load attendance/);
  assert.match(page, /does not exist\|schema cache/);
});
