import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const enrolments = readFileSync(new URL("./enrolments.ts", import.meta.url), "utf8");
const lifecycleActions = readFileSync(
  new URL("../../app/people/workforce-lifecycle/actions.ts", import.meta.url),
  "utf8"
);
const fieldExecutiveActions = readFileSync(
  new URL("../../app/field-executive/actions.ts", import.meta.url),
  "utf8"
);
const transactionalMigration = readFileSync(
  new URL("../../../supabase/migrations/20261011190000_transactional_biometric_enrolment_assignment.sql", import.meta.url),
  "utf8"
);

test("profile status does not close an assigned biometric enrolment", () => {
  assert.match(transactionalMigration, /v_status := case when v_is_active then 'Active' else 'Inactive' end/);
  assert.match(transactionalMigration, /v_status, v_effective_from,[\s\S]*?null, 'Synchronized from '/);
  assert.doesNotMatch(enrolments, /effective_to: isActive \? null : today/);
});

test("the enrolment RPC accepts identity only and derives its own close set", () => {
  assert.match(enrolments, /\.rpc\("replace_biometric_enrolment_assignment"/);
  assert.match(enrolments, /p_account_id: personId/);
  assert.match(enrolments, /p_company_id: companyId/);
  assert.match(enrolments, /p_profile_type: resolvedProfileType/);
  assert.doesNotMatch(enrolments, /p_close_ids|p_existing_id|p_payload|p_prior_effective_to/);
  assert.doesNotMatch(transactionalMigration, /p_close_ids|p_existing_id|p_payload|p_prior_effective_to/);
});

test("the database validates the master profile and strictly normalizes its biometric ID", () => {
  assert.match(transactionalMigration, /from public\.employees profile[\s\S]*?for update/);
  assert.match(transactionalMigration, /from public\.workforce profile[\s\S]*?for update/);
  assert.match(transactionalMigration, /from public\.helpers profile/);
  assert.match(transactionalMigration, /v_enrolment_id := public\.normalize_people_biometric_id\(v_master_biometric_id\)/);
  assert.match(transactionalMigration, /v_master_biometric_id is not null and v_enrolment_id is null/);
  assert.match(transactionalMigration, /station\.company_id = p_company_id and station\.id = v_location_id/);
});

test("reassignment windows close yesterday and never reuse an old joining date", () => {
  assert.match(enrolments, /const today = istDate\(new Date\(\)\)/);
  assert.doesNotMatch(enrolments, /const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(transactionalMigration, /clock_timestamp\(\) at time zone 'Asia\/Kolkata'/);
  assert.match(transactionalMigration, /v_prior_effective_to := v_assignment_date - 1/);
  assert.match(transactionalMigration, /when v_has_prior_owner then v_assignment_date[\s\S]*?else coalesce\(v_joining_date, v_assignment_date\)/);
  assert.match(transactionalMigration, /effective_to = v_prior_effective_to/);
});

test("assignment replacement is atomic and serialized in the database", () => {
  assert.match(transactionalMigration, /create or replace function public\.replace_biometric_enrolment_assignment/);
  assert.match(transactionalMigration, /pg_advisory_xact_lock/);
  assert.match(transactionalMigration, /for update/);
  assert.match(transactionalMigration, /update public\.biometric_enrolments[\s\S]*?insert into public\.biometric_enrolments/);
  assert.match(transactionalMigration, /raise exception 'Biometric enrolment cannot be reassigned more than once on the same date\.'/);
  assert.match(transactionalMigration, /security invoker/);
  assert.match(transactionalMigration, /grant execute on function public\.replace_biometric_enrolment_assignment[\s\S]*?to service_role/);
});

test("location changes create a new dated mapping instead of rewriting history", () => {
  assert.match(transactionalMigration, /be\.location_id is not distinct from v_location_id/);
  assert.match(transactionalMigration, /when v_target_id is not null then v_target\.effective_from[\s\S]*?when v_has_prior_owner then v_assignment_date/);
  assert.match(transactionalMigration, /and be\.id is distinct from v_target_id[\s\S]*?effective_to = v_prior_effective_to/);
});

test("cross-category shared IDs are never closed by another owner's sync", () => {
  assert.match(transactionalMigration, /Cross-category sharing is grandfathered/);
  assert.match(transactionalMigration, /is distinct from p_account_id/);
  assert.match(transactionalMigration, /Close only this owner/);
  assert.doesNotMatch(transactionalMigration, /any\(p_close_ids\)/);
});

test("profile saves bound historical backfill to the recent 62-day inclusive window", () => {
  assert.match(enrolments, /backfillHistorical = false/);
  assert.match(enrolments, /function boundedHistoricalBackfillStart\(effectiveFrom: string, today: string\)/);
  assert.match(enrolments, /cutoff\.setUTCDate\(cutoff\.getUTCDate\(\) - 61\)/);
  assert.match(enrolments, /return effectiveFrom > recentStart \? effectiveFrom : recentStart/);
  assert.match(
    enrolments,
    /backfillHistoricalPunches\(\{[\s\S]*?effectiveFrom: boundedHistoricalBackfillStart\(assigned\.effective_from \?\? effectiveFrom, today\),[\s\S]*?effectiveTo: null,[\s\S]*?enrolmentId: assigned\.enrolment_id/
  );
});

test("final settlement changes lifecycle status without unassigning the biometric ID", () => {
  const settlementStart = lifecycleActions.indexOf("export async function completeWorkforceSettlement");
  assert.notEqual(settlementStart, -1);
  const settlement = lifecycleActions.slice(settlementStart);
  assert.match(settlement, /biometric_enrolments[\s\S]*?update\(\{ status: "Inactive", updated_at: now \}\)/);
  assert.doesNotMatch(settlement, /biometric_enrolments[\s\S]*?effective_to: effectiveDate/);
});

test("manual and bulk Workforce onboarding create mappings before activation", () => {
  const createStart = fieldExecutiveActions.indexOf("export async function createFieldExecutive");
  const updateStart = fieldExecutiveActions.indexOf("export async function updateFieldExecutive", createStart);
  const createAction = fieldExecutiveActions.slice(createStart, updateStart);
  assert.match(createAction, /await syncBiometricEnrolment\(\{[\s\S]*?isActive: config\.profileType !== "field_executive"/);
  assert.doesNotMatch(createAction, /if \(config\.profileType !== "field_executive"\) \{[\s\S]*?syncBiometricEnrolment/);

  const bulkStart = fieldExecutiveActions.indexOf("export async function bulkImportFieldExecutives");
  const bulkAction = fieldExecutiveActions.slice(bulkStart);
  const syncStart = bulkAction.indexOf("await syncBiometricEnrolment({");
  const onboardingStart = bulkAction.indexOf('if (config.profileType === "field_executive")', syncStart);
  assert.ok(syncStart >= 0 && onboardingStart > syncStart, "bulk mapping must be created before the pending onboarding event");
  assert.match(bulkAction.slice(syncStart, onboardingStart), /isActive: lifecycle\.isActive/);
  assert.match(bulkAction.slice(syncStart, onboardingStart), /profileType: config\.profileType/);
});
