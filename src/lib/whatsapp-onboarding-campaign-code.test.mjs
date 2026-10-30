import assert from "node:assert/strict";
import test from "node:test";
import {
  isDuplicateCampaignCodeError,
  maxOnboardingCampaignNumber,
  nextOnboardingCampaignCodeFallback
} from "./whatsapp-onboarding-campaign-code.ts";

test("max ignores non-numeric and timestamp-style ONBOARD codes", () => {
  assert.equal(maxOnboardingCampaignNumber([]), 0);
  assert.equal(maxOnboardingCampaignNumber(["ONBOARD-12", "onboard-7", null, "ONBOARD-abc", "ONBOARD-1730000000000-x"]), 12);
  assert.equal(maxOnboardingCampaignNumber(["ONBOARD-214", "ONBOARD-99", "OTHER-300"]), 214);
});

test("fallback uses max+1, never count+1 (the production collision)", () => {
  // 213 rows but max code 214 → count+1 would reuse ONBOARD-214.
  const codes = Array.from({ length: 213 }, (_, index) => `ONBOARD-${index + 1}`);
  codes[212] = "ONBOARD-214";
  assert.equal(codes.length, 213);
  assert.equal(nextOnboardingCampaignCodeFallback(codes), "ONBOARD-215");
});

test("fallback with empty list starts at ONBOARD-1", () => {
  assert.equal(nextOnboardingCampaignCodeFallback([]), "ONBOARD-1");
});

test("gaps do not reuse an existing higher code", () => {
  assert.equal(
    nextOnboardingCampaignCodeFallback(["ONBOARD-1", "ONBOARD-2", "ONBOARD-50"]),
    "ONBOARD-51"
  );
});

test("duplicate campaign_code postgres errors are recognized for retry", () => {
  assert.equal(
    isDuplicateCampaignCodeError('duplicate key value violates unique constraint "whatsapp_campaigns_campaign_code_key"'),
    true
  );
  assert.equal(isDuplicateCampaignCodeError("Meta rejected the WhatsApp message."), false);
});
