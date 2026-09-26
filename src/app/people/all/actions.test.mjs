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
  assert.match(action, /updatedAt: String\(update\.data\.updated_at \?\? nextUpdatedAt\)[\s\S]*?changedKeys: patch\.changedKeys,[\s\S]*?savedValues: patch\.canonicalValues/);
});

test("save action keeps linked designation and biometric state aligned", () => {
  assert.match(action, /if \(source\.categoryCode === "workforce"\) payload\.designation = next\.name/);
  assert.match(action, /\["location_id", "date_of_join", "is_active"\]\.some/);
  assert.match(action, /await syncBiometricEnrolment\(/);
});

test("sensitive edits reuse matching server-persisted verification and safely invalidate stale results", () => {
  assert.match(action, /if \("driving_license_no" in payload \|\| "date_of_birth" in payload\) verificationKinds\.push\("dl"\)/);
  assert.match(action, /if \("pan_number" in payload\) verificationKinds\.push\("pan", "pan_aadhaar"\)/);
  assert.match(action, /if \("full_name" in payload\) verificationKinds\.push\("pan", "dl", "pf_uan"\)/);
  assert.match(action, /employees: "employee"/);
  assert.match(action, /workforce: "field_executive"/);
  assert.match(action, /\.select\("kind, input_key, details"\)/);
  assert.match(action, /details\.registeredName/);
  assert.match(action, /matchingKinds = new Set/);
  assert.match(action, /kindsToInvalidate = uniqueVerificationKinds\.filter/);
  assert.match(action, /\.in\("profile_type", storedProfileTypes\)\.in\("kind", kindsToInvalidate\)/);
  assert.match(action, /verified_at: null/);
  assert.match(action, /details: \{ invalidated: true, reason: "profile_field_update" \}/);
  assert.match(action, /await saveProfileVerification\(/);
  assert.doesNotMatch(action, /verificationResults/);
});

test("verification invalidation fails closed before the profile write", () => {
  const verificationStart = action.indexOf("const verificationKinds: VerificationKind[]");
  const profileUpdate = action.indexOf("const update = await supabaseAdmin.from(source.table).update");
  assert.ok(verificationStart > -1 && verificationStart < profileUpdate);
  assert.match(action, /return failure\(`Verification status could not be updated, so the profile was not saved:/);
  assert.match(action, /"VERIFICATION_UPDATE_FAILED"/);
  assert.doesNotMatch(action, /Profile saved, but verification status could not be updated/);
});
