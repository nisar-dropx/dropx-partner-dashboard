import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  directPaymentProfileIsEditable,
  directPaymentProfileIsVisible,
  directPaymentProfileStatus
} from "./direct-payment-profile-visibility.ts";

function functionDefinition(source, functionName) {
  const marker = `create or replace function public.${functionName}(`;
  const start = source.toLowerCase().lastIndexOf(marker);
  if (start < 0) return "";
  const bodyStart = source.indexOf("as $$", start);
  const end = source.indexOf("$$;", bodyStart);
  return bodyStart >= 0 && end >= 0 ? source.slice(start, end + 3) : source.slice(start);
}

test("Workforce direct pay allows non-terminal registration profiles but excludes true Inactive profiles", () => {
  for (const onboarding_status of ["pending", "under_review", "returned", "approved"]) {
    const profile = { onboarding_status, lifecycle_status: "onboarding", is_active: false };
    assert.equal(directPaymentProfileIsVisible(profile, "workforce"), true, onboarding_status);
    assert.equal(directPaymentProfileIsEditable(profile, "workforce"), true, onboarding_status);
  }

  for (const onboarding_status of ["rejected", "cancelled"]) {
    const profile = { onboarding_status, lifecycle_status: "onboarding", is_active: false };
    assert.equal(directPaymentProfileIsVisible(profile, "workforce"), true, onboarding_status);
    assert.equal(directPaymentProfileIsEditable(profile, "workforce"), false, onboarding_status);
  }

  const active = { onboarding_status: "active", lifecycle_status: "active", is_active: true };
  assert.equal(directPaymentProfileStatus(active, "workforce"), "Active");
  assert.equal(directPaymentProfileIsVisible(active, "workforce"), true);
  assert.equal(directPaymentProfileIsEditable(active, "workforce"), true);

  for (const lifecycle_status of ["settlement_pending", "offboarding", "exited", "offboarded", "suspended"]) {
    const profile = { onboarding_status: "active", lifecycle_status, is_active: false };
    assert.equal(directPaymentProfileIsVisible(profile, "workforce"), true, lifecycle_status);
    assert.equal(directPaymentProfileIsEditable(profile, "workforce"), false, lifecycle_status);
  }

  for (const inactive of [
    { onboarding_status: "active", lifecycle_status: "active", is_active: false },
    { onboarding_status: "active", lifecycle_status: "active", is_active: true, deleted_at: "2026-10-14" }
  ]) {
    assert.equal(directPaymentProfileStatus(inactive, "workforce"), "Inactive");
    assert.equal(directPaymentProfileIsVisible(inactive, "workforce"), false);
    assert.equal(directPaymentProfileIsEditable(inactive, "workforce"), false);
  }
});

test("Helper direct pay shows every non-Inactive status while preserving active-only saves", () => {
  for (const onboarding_status of ["pending", "under_review", "returned", "approved", "rejected", "cancelled", "active"]) {
    const helper = { onboarding_status, is_active: true };
    assert.equal(directPaymentProfileIsVisible(helper, "helpers"), true, onboarding_status);
    assert.equal(directPaymentProfileIsEditable(helper, "helpers"), onboarding_status === "active", onboarding_status);
  }
  const inactive = { onboarding_status: "pending", is_active: false };
  assert.equal(directPaymentProfileStatus(inactive, "helpers"), "Inactive");
  assert.equal(directPaymentProfileIsVisible(inactive, "helpers"), false);
});

test("direct-pay queries load statuses and apply the shared visibility policy instead of active-only SQL filters", () => {
  const page = readFileSync(new URL("../app/provider-mapping/direct-pay/page.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../app/provider-mapping/direct-pay/actions.ts", import.meta.url), "utf8");
  const worksheet = readFileSync(new URL("../components/direct-payment-allocation-worksheet.tsx", import.meta.url), "utf8");
  const designationQuery = page.match(/from\("designations"\)([\s\S]*?)\.order\("code"\)/)?.[0] ?? "";
  const actionDesignationQuery = actions.match(/from\("designations"\)([\s\S]*?)\.eq\("provider_mapping_required", false\)/)?.[0] ?? "";
  const helperQuery = page.match(/from\("helpers"\)([\s\S]*?)\.order\("dropx_id"\)/)?.[0] ?? "";
  const workforceQuery = page.match(/from\("workforce"\)([\s\S]*?)\.order\("dropx_id"\)/)?.[0] ?? "";

  // Direct-pay eligibility is independent of the Field Operations flag. A
  // non-field designation is eligible when provider mapping is not required;
  // provider-mapped designations remain excluded from this screen.
  assert.match(designationQuery, /\.eq\("provider_mapping_required", false\)/);
  assert.doesNotMatch(designationQuery, /\.eq\("is_field_operations", true\)/);
  assert.match(actionDesignationQuery, /\.eq\("provider_mapping_required", false\)/);
  assert.doesNotMatch(actionDesignationQuery, /\.eq\("is_field_operations", true\)/);
  assert.match(helperQuery, /onboarding_status, is_active/);
  assert.doesNotMatch(helperQuery, /\.eq\("is_active", true\)|\.eq\("onboarding_status", "active"\)/);
  assert.match(workforceQuery, /onboarding_status, lifecycle_status, is_active, deleted_at/);
  assert.doesNotMatch(workforceQuery, /\.eq\("is_active", true\)/);
  assert.match(page, /directPaymentProfileIsVisible\(person, audience\)/);
  assert.match(page, /profileEditable: directPaymentProfileIsEditable\(person, audience\)/);
  assert.match(actions, /directPaymentProfileIsEditable\(workerResult\.data, "workforce"\)/);
  assert.doesNotMatch(
    actions.match(/from\("workforce"\)([\s\S]*?)\.maybeSingle\(\)/)?.[0] ?? "",
    /\.eq\("is_active", true\)/
  );
  assert.match(worksheet, /const editable = canEdit && row\.profileEditable/);
  assert.match(worksheet, /disabled=\{!methodId \|\| !editable\}/);
  assert.match(worksheet, /row\.profileEditable \? "Save" : "View only"/);
});

test("database direct-pay saves allow non-terminal registration profiles without allowing terminal profiles", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261016093000_direct_pay_pending_workforce_setup.sql", import.meta.url), "utf8");
  const deployScript = readFileSync(new URL("../../scripts/direct_pay_pending_workforce_setup_v1.sql", import.meta.url), "utf8");

  assert.equal(deployScript, migration, "the standalone deploy SQL must exactly match its migration");
  assert.match(migration, /workforce\.is_active = true/);
  for (const status of ["pending", "under_review", "returned", "approved"]) {
    assert.match(migration, new RegExp(`''${status}''`));
  }
  assert.match(migration, /workforce\.lifecycle_status/);
  assert.doesNotMatch(migration, /''rejected''|''cancelled''/);
  assert.match(migration, /pg_get_functiondef\([\s\S]*?save_workforce_payment_allocation/);
  assert.match(
    migration,
    /if position\(v_old_predicate in v_after\) > 0 then[\s\S]*?elsif position\([\s\S]*?in v_after\) = 0 then/,
    "the guarded function rewrites must recognize an already-applied deployment"
  );
  assert.match(migration, /reconcile_workforce_direct_payment_transition/);
  assert.match(migration, /not \([\s\S]*?new\.onboarding_status[\s\S]*?new\.lifecycle_status/);
});

test("payouts exclude Inactive direct allocations without filtering provider-ID mappings", () => {
  const loader = readFileSync(new URL("./workforce-payout-loader.ts", import.meta.url), "utf8");
  const directVisibilityStart = loader.indexOf("const directAllocationProfileIsVisible");
  const providerSegmentStart = loader.indexOf("const providerSegments = mappings.flatMap");

  assert.ok(directVisibilityStart >= 0, "the shared payout loader must apply the direct-pay profile policy");
  assert.match(
    loader.slice(directVisibilityStart, directVisibilityStart + 700),
    /directPaymentProfileIsVisible\([\s\S]*?"workforce"[\s\S]*?allDirectAllocations = allDirectAllocations\.filter\(directAllocationProfileIsVisible\)[\s\S]*?directAllocations = directAllocations\.filter\(directAllocationProfileIsVisible\)/
  );
  assert.ok(providerSegmentStart > directVisibilityStart, "provider payout mappings must remain a separate population path");
  assert.doesNotMatch(
    loader.slice(providerSegmentStart, providerSegmentStart + 800),
    /directPaymentProfileIsVisible|directAllocationProfileIsVisible/,
    "a mapped Provider ID must remain visible regardless of the linked profile status"
  );

  const orphanPayoutInputStart = loader.indexOf("for (const [identityKey, group] of payoutValueGroups)");
  assert.ok(orphanPayoutInputStart >= 0, "the payout-input fallback must remain covered");
  assert.match(
    loader.slice(orphanPayoutInputStart, orphanPayoutInputStart + 900),
    /if \(!directPaymentProfileIsVisible\(worker, "workforce"\)\) continue;/,
    "old additions or deductions must not recreate an Inactive Direct Pay row"
  );
});

test("database direct-pay policy is independent of the Field Operations flag", () => {
  const baseMigration = readFileSync(new URL("../../supabase/migrations/20260928100000_workforce_payment_allocations.sql", import.meta.url), "utf8");
  const independenceMigration = readFileSync(new URL("../../supabase/migrations/20261014090000_direct_pay_field_operations_independence.sql", import.meta.url), "utf8");
  const saveFunction = functionDefinition(baseMigration, "save_workforce_payment_allocation");
  const guardFunction = functionDefinition(independenceMigration, "guard_designation_direct_payment_policy");

  assert.ok(saveFunction, "save_workforce_payment_allocation must be defined by a migration");
  assert.match(saveFunction, /designation\.provider_mapping_required\s*=\s*false/);
  assert.match(independenceMigration, /replace\(v_after, E'\\n    and designation\.is_field_operations = true', ''\)/);
  const patchedSaveFunction = saveFunction.replace("\n    and designation.is_field_operations = true", "");
  assert.equal(/designation\.is_field_operations\s*=\s*true/.test(patchedSaveFunction), false,
    "the guarded migration patch must remove the Field Operations save requirement");
  assert.ok(guardFunction, "guard_designation_direct_payment_policy must be defined by a migration");
  assert.equal(/new\.is_field_operations\s*=\s*false/.test(guardFunction), false,
    "changing Field Operations must not invalidate an existing direct allocation");
  assert.match(independenceMigration, /v_new_direct_eligible := v_new_designation\.provider_mapping_required = false;/);
  assert.match(independenceMigration, /v_provider_mapping_required:=v_designation_is_active and coalesce\(v_designation\.provider_mapping_required,false\);/);
});
