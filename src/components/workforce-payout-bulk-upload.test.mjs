import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-bulk-upload.tsx", import.meta.url), "utf8");

test("bulk payout upload explains date and attendance-minute rules", () => {
  assert.match(source, /set the inclusive allowed upload window/i);
  assert.match(source, /payable work minutes used for attendance and hourly calculations/i);
  assert.match(source, /keep existing biometric minutes/i);
  assert.match(source, /whole number from 0 to 1440/i);
});

test("bulk payout upload requires an explicit scoped-replacement confirmation", () => {
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /Inputs not represented by an uploaded row remain unchanged/i);
  assert.match(source, /does not replace C-return, attendance, deductions, additional payments, or any other production field/i);
  assert.match(source, /manual deductions/i);
  assert.match(source, /Confirm matching replacements/);
});
