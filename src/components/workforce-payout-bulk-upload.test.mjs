import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-bulk-upload.tsx", import.meta.url), "utf8");

test("bulk payout upload keeps the selected period hidden and explains the single Excel date", () => {
  assert.doesNotMatch(source, /<span>Effective from<\/span>/i);
  assert.doesNotMatch(source, /<span>Effective to<\/span>/i);
  assert.match(source, /one EFFECTIVE_DATE on every row/i);
  assert.match(source, /DD-MM-YYYY or DD\/MM\/YYYY/i);
  assert.match(source, /selected worksheet period/i);
  assert.match(source, /body\.set\("effective_from", fromDate\)/);
  assert.match(source, /body\.set\("effective_to", toDate\)/);
});

test("bulk payout upload explains mutually exclusive mapped attendance units", () => {
  assert.doesNotMatch(source, /WORK_MINUTES/);
  assert.match(source, /fill exactly one column: WORK_HOURS/i);
  assert.match(source, /WORK_DAYS/i);
  assert.match(source, /mapped to per-hour attendance/i);
  assert.match(source, /mapped to per-day attendance/i);
  assert.match(source, /does not match the person.{0,40}attendance payment mapping/i);
});

test("bulk payout upload requires an explicit scoped-replacement confirmation", () => {
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /Inputs not represented by an uploaded row remain unchanged/i);
  assert.match(source, /does not replace C-return, attendance, deductions, additional payments, or any other production field/i);
  assert.match(source, /manual deductions/i);
  assert.match(source, /Confirm matching replacements/);
});
