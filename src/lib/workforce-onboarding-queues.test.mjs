import assert from "node:assert/strict";
import test from "node:test";
import { workforceOnboardingView, workforceQueueCounts, workforceQueueFor } from "./workforce-onboarding-queues.ts";

const state = (overrides = {}) => ({
  reported_on: "2026-10-01",
  registration_ready: true,
  mapping_confirmed: false,
  stage: "id_creation_pending",
  due_kind: null,
  ...overrides
});

test("workforce queues keep onboarding stages separate while retaining attention", () => {
  const rows = [
    { isActive: false, onboardingStatus: "pending", partnerOnboarding: state({ reported_on: null, registration_ready: false, stage: "registration_pending" }) },
    { isActive: false, onboardingStatus: "pending", partnerOnboarding: state({ registration_ready: false, stage: "registration_pending" }) },
    { isActive: false, onboardingStatus: "approved", partnerOnboarding: state() },
    { isActive: true, onboardingStatus: "active", partnerOnboarding: state({ mapping_confirmed: true, stage: "active" }) },
    { isActive: false, onboardingStatus: "approved", partnerOnboarding: state({ stage: "exception", due_kind: "progress_due" }) }
  ];
  const counts = workforceQueueCounts(rows);
  assert.equal(counts.training, 1);
  assert.equal(counts.registration, 1);
  assert.equal(counts.amazon, 1);
  assert.equal(counts.active, 1);
  assert.equal(counts.attention, 1);
});

test("old register links resolve to the equivalent new queue", () => {
  assert.equal(workforceOnboardingView("pending"), "training");
  assert.equal(workforceOnboardingView("due"), "attention");
  assert.equal(workforceOnboardingView("active"), "active");
  assert.equal(workforceQueueFor({ isActive: true, onboardingStatus: "active" }, "active"), true);
});
