import assert from "node:assert/strict";
import test from "node:test";
import { workforceRegistrationSubmission } from "./workforce-registration-submission.ts";

const submittedAt = "2026-10-15T10:15:30.000Z";

function submission(changes = {}) {
  return workforceRegistrationSubmission({
    accountId: "workforce-1",
    companyId: "company-1",
    currentStatus: "pending",
    manualReviewRequired: false,
    profileType: "workforce",
    submittedAt,
    ...changes
  });
}

test("canonical Workforce submission records durable completion evidence", () => {
  const result = submission();
  assert.equal(result.profilePatch.onboarding_status, "active");
  assert.equal(result.profilePatch.is_active, true);
  assert.equal(result.profilePatch.onboarding_submitted_at, submittedAt);
  assert.equal(Object.hasOwn(result.profilePatch, "lifecycle_status"), false);
  assert.deepEqual(result.onboardingEvent, {
    company_id: "company-1",
    workforce_id: "workforce-1",
    event_code: "candidate_submitted",
    from_status: "pending",
    to_status: "active",
    source_portal: "connect",
    remarks: "Applicant submitted Workforce registration in DropX One."
  });
});

test("canonical Workforce manual review keeps the evidence but retains review behavior", () => {
  const result = submission({ manualReviewRequired: true, currentStatus: "returned" });
  assert.equal(result.profilePatch.onboarding_status, "under_review");
  assert.equal(result.profilePatch.is_active, true);
  assert.equal(result.profilePatch.onboarding_submitted_at, submittedAt);
  assert.equal(result.onboardingEvent?.from_status, "returned");
  assert.equal(result.onboardingEvent?.to_status, "under_review");
});

test("legacy field-executive submission preserves the existing HO review flow", () => {
  const result = submission({ profileType: "field_executive" });
  assert.equal(result.profilePatch.onboarding_status, "under_review");
  assert.equal(result.profilePatch.is_active, false);
  assert.equal(result.profilePatch.onboarding_submitted_at, submittedAt);
  assert.equal(result.profilePatch.lifecycle_status, "onboarding");
  assert.deepEqual(result.onboardingEvent, {
    company_id: "company-1",
    field_executive_id: "workforce-1",
    event_code: "candidate_submitted",
    from_status: "pending",
    to_status: "under_review",
    source_portal: "connect",
    remarks: "Applicant submitted profile and agreement for HO review."
  });
});

test("other non-employee profiles keep their existing status behavior", () => {
  const direct = submission({ profileType: "contractor" });
  assert.equal(direct.profilePatch.onboarding_status, "active");
  assert.equal(direct.profilePatch.is_active, true);
  assert.equal(Object.hasOwn(direct.profilePatch, "onboarding_submitted_at"), false);
  assert.equal(direct.onboardingEvent, null);

  const reviewed = submission({ profileType: "worker", manualReviewRequired: true });
  assert.equal(reviewed.profilePatch.onboarding_status, "under_review");
  assert.equal(reviewed.profilePatch.is_active, true);
  assert.equal(reviewed.onboardingEvent, null);
});
