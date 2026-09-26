import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("verification notes use individual-form anchor fields and compare stored input keys to current values", () => {
  assert.match(page, /pan: "panNumber"/);
  assert.match(page, /pan_aadhaar: "panNumber"/);
  assert.match(page, /bank: "ifsc"/);
  assert.match(page, /dl: "drivingLicenseNumber"/);
  assert.match(page, /vehicle: "vehicleRegistrationNumber"/);
  assert.match(page, /pf_uan: "pfUan"/);
  assert.match(page, /expectedVerificationInputKey\(row, item\.kind\)/);
  assert.match(page, /Reverification required after profile field update/);
});

test("newest workforce verification wins across canonical and legacy profile types", () => {
  assert.match(page, /\.order\("updated_at", \{ ascending: false \}\)/);
  assert.match(page, /workforce: \["workforce", "field_executive"\]/);
  assert.match(page, /const seenRowKinds = new Set<string>\(\)/);
  assert.match(page, /if \(seenRowKinds\.has\(rowKind\)\) continue/);
  assert.match(page, /current\[column\] = current\[column\] \? `\$\{current\[column\]\} · \$\{next\}` : next/);
});

test("verification notes are loaded in bounded batches and query errors remain visible", () => {
  assert.match(page, /const accountIds = Array\.from\(new Set\(allRows\.map\(\(row\) => row\.id\)\)\)/);
  assert.match(page, /for \(let offset = 0; offset < accountIds\.length; offset \+= 100\)/);
  assert.match(page, /accountIds\.slice\(offset, offset \+ 100\)/);
  assert.match(page, /!isMissingVerificationTable\(verificationResult\.error\)/);
  assert.match(page, /workforceResult\.error \?\? verificationError \?\? null/);
});

test("view verification summaries retain structured provider details separately from edit messages", () => {
  assert.match(page, /manual_review, display_name, message, details, updated_at/);
  assert.match(page, /const summariesByRow = new Map/);
  assert.match(page, /buildVerificationViewSummary\(\{/);
  assert.match(page, /display_name: item\.display_name/);
  assert.match(page, /details: item\.details/);
  assert.match(page, /row\.verificationNotes = notesByRow\.get\(key\)/);
  assert.match(page, /row\.verificationSummaries = summariesByRow\.get\(key\)/);
});

test("view summaries reject stale inputs and normalize DL date formats", () => {
  assert.match(page, /function comparableVerificationInputKey\(kind: string, value: unknown\)/);
  assert.match(page, /const inputMatchesCurrent = comparableVerificationInputKey\(item\.kind, item\.input_key\) === comparableVerificationInputKey\(item\.kind, expectedVerificationInputKey\(row, item\.kind\)\)/);
  assert.match(page, /if \(inputMatchesCurrent\) \{/);
  assert.match(page, /matchNames\(row\.fullName, providerName\)\.status/);
  assert.match(page, /nameMatchStatus: currentNameMatch/);
});
