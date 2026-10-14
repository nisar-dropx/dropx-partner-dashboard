import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  directPaymentProfileIsEditable,
  directPaymentProfileIsVisible,
  directPaymentProfileStatus
} from "./direct-payment-profile-visibility.ts";

test("Workforce direct pay shows onboarding statuses but excludes true Inactive profiles", () => {
  for (const onboarding_status of ["pending", "under_review", "returned", "approved", "rejected", "cancelled"]) {
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
  const worksheet = readFileSync(new URL("../components/direct-payment-allocation-worksheet.tsx", import.meta.url), "utf8");
  const helperQuery = page.match(/from\("helpers"\)([\s\S]*?)\.order\("dropx_id"\)/)?.[0] ?? "";
  const workforceQuery = page.match(/from\("workforce"\)([\s\S]*?)\.order\("dropx_id"\)/)?.[0] ?? "";

  assert.match(helperQuery, /onboarding_status, is_active/);
  assert.doesNotMatch(helperQuery, /\.eq\("is_active", true\)|\.eq\("onboarding_status", "active"\)/);
  assert.match(workforceQuery, /onboarding_status, lifecycle_status, is_active, deleted_at/);
  assert.doesNotMatch(workforceQuery, /\.eq\("is_active", true\)/);
  assert.match(page, /directPaymentProfileIsVisible\(person, audience\)/);
  assert.match(page, /profileEditable: directPaymentProfileIsEditable\(person, audience\)/);
  assert.match(worksheet, /const editable = canEdit && row\.profileEditable/);
  assert.match(worksheet, /disabled=\{!methodId \|\| !editable\}/);
  assert.match(worksheet, /row\.profileEditable \? "Save" : "View only"/);
});
