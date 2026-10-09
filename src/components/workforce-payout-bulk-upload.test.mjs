import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-bulk-upload.tsx", import.meta.url), "utf8");

test("bulk payout upload keeps the selected period hidden and requires workbook dates", () => {
  assert.doesNotMatch(source, /<span>Effective from<\/span>/i);
  assert.doesNotMatch(source, /<span>Effective to<\/span>/i);
  assert.match(source, /Enter EFFECTIVE_DATE and the compulsory EFFECTIVE_TO on every row/i);
  assert.match(source, /DD-MM-YYYY or DD\/MM\/YYYY/i);
  assert.match(source, /selected worksheet period/i);
  assert.match(source, /no separate effective-date controls/i);
  assert.match(source, /body\.set\("effective_from", fromDate\)/);
  assert.match(source, /body\.set\("effective_to", toDate\)/);
  assert.match(source, /<th>FIELD_CODE<\/th><th>VALUE<\/th><th>EFFECTIVE_DATE<\/th><th>EFFECTIVE_TO<\/th>/);
});

test("bulk payout upload explains attendance field codes and mapped units", () => {
  assert.doesNotMatch(source, /WORK_MINUTES/);
  assert.doesNotMatch(source, /row\.workHours|row\.workDays/);
  assert.match(source, /set FIELD_CODE to WORK_HOURS or WORK_DAYS/i);
  assert.match(source, /enter the quantity in VALUE/i);
  assert.match(source, /WORK_HOURS only for hourly attendance pay/i);
  assert.match(source, /WORK_DAYS only for daily or monthly attendance pay/i);
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

test("bulk payout upload reports queued published-payout refresh warnings without hiding the successful import", () => {
  assert.match(source, /preview\?\.warnings/);
  assert.match(source, /Import completed with/);
  assert.match(source, /role="status"/);
});

test("a committed upload refreshes the worksheet immediately and closes the upload panel", () => {
  assert.match(source, /announceWorkforcePayoutInputsChanged\(/);
  assert.match(source, /setOpen\(false\)/);
  assert.match(source, /setFile\(null\)/);
  assert.match(source, /router\.refresh\(\)/);
});
