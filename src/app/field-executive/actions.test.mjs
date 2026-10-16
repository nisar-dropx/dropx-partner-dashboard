import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const cleanupAction = action.slice(
  action.indexOf("async function cleanupNewlyInsertedProfiles"),
  action.indexOf("const fieldExecutiveDocumentFields")
);
const createAction = action.slice(
  action.indexOf("export async function createFieldExecutive"),
  action.indexOf("export async function updateFieldExecutive")
);
const bulkImportAction = action.slice(
  action.indexOf("export async function bulkImportFieldExecutives"),
  action.indexOf("export async function queueAmazonInvitationFromOpsPulse")
);

test("single Workforce creation checks the onboarding event and removes its new profile on failure", () => {
  assert.match(createAction, /const onboardingEvent = await supabaseAdmin\.from\("workforce_onboarding_events"\)\.insert/);
  assert.match(createAction, /if \(onboardingEvent\.error\) \{[\s\S]*?cleanupNewlyInsertedProfiles\(\{[\s\S]*?companyId,[\s\S]*?config,[\s\S]*?profileIds: \[String\(executive\.id\)\][\s\S]*?\}\);/);
  assert.match(createAction, /throw new Error\(`Unable to record the Workforce onboarding request:/);
});

test("bulk Workforce creation fails on a missing onboarding event and reports the source row", () => {
  assert.match(bulkImportAction, /rowNumber: number/);
  assert.match(bulkImportAction, /inserted\.push\(\{ id: insertResult\.data\.id,[\s\S]*?rowNumber \}\)/);
  assert.match(bulkImportAction, /const onboardingEvent = await supabaseAdmin\.from\("workforce_onboarding_events"\)\.insert/);
  assert.match(bulkImportAction, /if \(onboardingEvent\.error\) \{\s*throw new Error\(`Row \$\{row\.rowNumber\}: Unable to record the Workforce onboarding request:/);
  assert.match(bulkImportAction, /const cleanupFailures = await cleanupNewlyInsertedProfiles\(\{[\s\S]*?companyId,[\s\S]*?config,[\s\S]*?profileIds: insertedIds[\s\S]*?\}\);/);
});

test("failed creation cleanup checks events, biometric enrolments, and only the newly inserted profiles", () => {
  assert.match(cleanupAction, /const insertedIds = Array\.from\(new Set\(profileIds\.map\(String\)\.filter\(Boolean\)\)\)/);
  assert.match(cleanupAction, /from\("workforce_onboarding_events"\)[\s\S]*?\.in\(profileIdColumn, insertedIds\)/);
  assert.match(cleanupAction, /from\("biometric_enrolments"\)[\s\S]*?\.in\("field_executive_id", insertedIds\)/);
  assert.match(cleanupAction, /from\(config\.table\)[\s\S]*?\.eq\("company_id", companyId\)[\s\S]*?\.in\("id", insertedIds\)/);
  assert.match(cleanupAction, /if \(result\.error\) failures\.push/);
  assert.match(bulkImportAction, /Automatic cleanup was incomplete:/);
});
