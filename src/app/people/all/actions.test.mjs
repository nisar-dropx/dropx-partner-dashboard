import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

test("save action accepts sparse changes and removes canonical values that are already unchanged", () => {
  assert.match(action, /categoryCode: string; id: string; changes: SheetChanges; expectedUpdatedAt: string/);
  assert.match(action, /buildAllPeopleSheetPatch\(changes,/);
  assert.match(action, /for \(const \[column, value\] of Object\.entries\(payload\)\) if \(sameValue\(existing\[column\], value\)\) delete payload\[column\]/);
  assert.doesNotMatch(action, /buildAllPeopleSheetPatch\(values,/);
});

test("save action enforces optimistic concurrency before and during the update", () => {
  assert.match(action, /if \(!sameTimestamp\(existing\.updated_at, expectedUpdatedAt\)\) return failure\([^;]+"CONFLICT"\)/);
  assert.match(action, /\.eq\("updated_at", existing\.updated_at\)\.select\("updated_at"\)\.maybeSingle\(\)/);
  assert.match(action, /if \(!update\.data\) return failure\([^;]+"CONFLICT"\)/);
  assert.match(action, /return \{ ok: true as const, updatedAt:[^}]+changedKeys: patch\.changedKeys, warning \}/);
});

test("save action keeps linked designation and biometric state aligned", () => {
  assert.match(action, /if \(source\.categoryCode === "workforce"\) payload\.designation = next\.name/);
  assert.match(action, /\["location_id", "date_of_join", "is_active"\]\.some/);
  assert.match(action, /await syncBiometricEnrolment\(/);
});
