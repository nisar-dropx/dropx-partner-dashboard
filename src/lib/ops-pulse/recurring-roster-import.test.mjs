import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

function compile(path) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", code)(require, module.exports, module);
  return module.exports;
}

const {
  expandRosterPatternDates,
  resolveRosterBulkUploadWindow
} = compile("./recurring-roster-import.ts");

test("month bulk-upload window uses full calendar month bounds", () => {
  assert.deepEqual(resolveRosterBulkUploadWindow({ mode: "month", rosterMonth: "2026-09", today: "2026-09-02" }), {
    mode: "month",
    label: "2026-09",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    writeStart: "2026-09-01",
    writeEnd: "2026-09-30"
  });
});

test("week bulk-upload window is the exact Monday–Sunday week", () => {
  assert.deepEqual(resolveRosterBulkUploadWindow({ mode: "week", weekStart: "2026-09-10", today: "2026-09-02" }), {
    mode: "week",
    label: "week 2026-09-07 → 2026-09-13",
    periodStart: "2026-09-07",
    periodEnd: "2026-09-13",
    writeStart: "2026-09-07",
    writeEnd: "2026-09-13"
  });
});

test("week bulk-upload rejects the current or a past week — upcoming only", () => {
  assert.throws(() => resolveRosterBulkUploadWindow({ mode: "week", weekStart: "2026-09-03", today: "2026-09-02" }), /upcoming week/);
  assert.throws(() => resolveRosterBulkUploadWindow({ mode: "week", weekStart: "2026-08-20", today: "2026-09-02" }), /upcoming week/);
});

test("month bulk-upload rejects a month that has already fully passed", () => {
  assert.throws(() => resolveRosterBulkUploadWindow({ mode: "month", rosterMonth: "2026-08", today: "2026-09-02" }), /current month or an upcoming month/);
});

test("month bulk-upload allows the current month (remaining days) and future months", () => {
  assert.equal(resolveRosterBulkUploadWindow({ mode: "month", rosterMonth: "2026-09", today: "2026-09-02" }).label, "2026-09");
  assert.equal(resolveRosterBulkUploadWindow({ mode: "month", rosterMonth: "2026-10", today: "2026-09-02" }).label, "2026-10");
});

test("weekday columns expand across every matching date in a month window", () => {
  assert.deepEqual(expandRosterPatternDates("2026-09-01", "2026-09-30", "MONDAY"), [
    "2026-09-07",
    "2026-09-14",
    "2026-09-21",
    "2026-09-28"
  ]);
  assert.deepEqual(expandRosterPatternDates("2026-08-31", "2026-09-06", "WEDNESDAY"), ["2026-09-02"]);
});
