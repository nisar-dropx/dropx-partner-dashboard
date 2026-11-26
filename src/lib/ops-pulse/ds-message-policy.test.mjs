import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideDsMessageSend,
  fallbackDsMessagePolicy,
  reportBotCategoryNeedsApproval
} from "./ds-message-policy.ts";
import { categoryHighRiskForDelivery } from "../report-bot/logic.ts"; // relative — no @/ alias

const basePolicy = (overrides = {}) => ({
  messageType: "shift_noshow",
  urgency: "high",
  frequency: "cooldown",
  cooldownMinutes: 15,
  quietStartMinute: null,
  quietEndMinute: null,
  thresholdSeconds: null,
  enabled: true,
  version: 1,
  ...overrides
});

test("decideDsMessageSend blocks when muted or disabled", () => {
  const muted = decideDsMessageSend({
    policy: basePolicy({ frequency: "mute" })
  });
  assert.equal(muted.allowSend, false);
  const off = decideDsMessageSend({
    policy: basePolicy({ enabled: false })
  });
  assert.equal(off.allowSend, false);
});

test("decideDsMessageSend enforces cooldown", () => {
  const now = Date.now();
  const blocked = decideDsMessageSend({
    policy: basePolicy({ cooldownMinutes: 10 }),
    lastSentAtMs: now - 5 * 60_000,
    nowMs: now
  });
  assert.equal(blocked.allowSend, false);
  assert.match(blocked.reason, /Cooldown/);
  const ok = decideDsMessageSend({
    policy: basePolicy({ cooldownMinutes: 10 }),
    lastSentAtMs: now - 20 * 60_000,
    nowMs: now
  });
  assert.equal(ok.allowSend, true);
});

test("decideDsMessageSend respects quiet hours (IST)", () => {
  // 02:00 IST = 20:30 UTC previous day → minute 120
  const ist120 = new Date("2026-01-15T20:30:00.000Z").getTime();
  const policy = basePolicy({ frequency: "immediate", quietStartMinute: 60, quietEndMinute: 180 });
  const quiet = decideDsMessageSend({ policy, nowMs: ist120 });
  assert.equal(quiet.allowSend, false);
  assert.equal(quiet.reason, "Quiet hours");
});

test("decideDsMessageSend lets digest cadence send when cooldown cleared", () => {
  const now = Date.now();
  const blocked = decideDsMessageSend({
    policy: basePolicy({ frequency: "digest", cooldownMinutes: 1440 }),
    lastSentAtMs: now - 60 * 60_000,
    nowMs: now
  });
  assert.equal(blocked.allowSend, false);
  const ok = decideDsMessageSend({
    policy: basePolicy({ frequency: "digest", cooldownMinutes: 1440 }),
    lastSentAtMs: now - 25 * 60 * 60_000,
    nowMs: now
  });
  assert.equal(ok.allowSend, true);
  assert.match(ok.reason, /Digest/);
});

test("decideDsMessageSend critical pierces quiet hours", () => {
  const ist120 = new Date("2026-01-15T20:30:00.000Z").getTime();
  const policy = basePolicy({
    urgency: "critical",
    frequency: "immediate",
    quietStartMinute: 60,
    quietEndMinute: 180
  });
  assert.equal(decideDsMessageSend({ policy, nowMs: ist120 }).allowSend, true);
});

test("reportBotCategoryNeedsApproval uses urgency", () => {
  const policies = [
    fallbackDsMessagePolicy("report_bot_cold_chain"),
    { ...fallbackDsMessagePolicy("report_bot_workforce"), urgency: "normal" }
  ];
  assert.equal(reportBotCategoryNeedsApproval("cold_chain", policies), true);
  assert.equal(reportBotCategoryNeedsApproval("workforce", policies), false);
});

test("categoryHighRiskForDelivery falls back to legacy set without policies", () => {
  assert.equal(categoryHighRiskForDelivery("cold_chain", []), true);
  assert.equal(categoryHighRiskForDelivery("cold_chain", undefined), true);
  assert.equal(categoryHighRiskForDelivery("other", []), false);
});

test("categoryHighRiskForDelivery honors DB policies when provided", () => {
  /** @type {DsMessagePolicy[]} */
  const policies = [{ ...fallbackDsMessagePolicy("report_bot_workforce"), urgency: "info" }];
  assert.equal(categoryHighRiskForDelivery("workforce", policies), false);
});