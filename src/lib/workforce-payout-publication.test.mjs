import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkforcePayoutPublicationSnapshot,
  workforcePayoutCalculationHash,
  workforcePayoutPublicationSnapshotHash
} from "./workforce-payout-publication.ts";

const row = (overrides = {}) => ({
  id: "mapping-1",
  dropxId: "DROPX1",
  dropxStatus: "Active",
  name: "Worker",
  designation: "DA",
  providerMemberId: "PROVIDER1",
  providerMemberName: "Provider Worker",
  locationId: "00000000-0000-4000-8000-000000000003",
  reviewSubjectType: "workforce",
  reviewSubjectId: "00000000-0000-4000-8000-000000000002",
  location: "TEST",
  provider: "Provider",
  model: "Model",
  paymentMethod: "Per packet",
  mappingStatus: "Mapped",
  paymentDetailsAvailable: true,
  workDays: 0,
  workDaysSource: "Biometric",
  production: 0,
  paymentMethodBreakdown: [{ id: "method-1", label: "Per packet", amount: 0 }],
  history: [],
  productionBreakdown: [],
  dailyBreakdown: [],
  additionalPaymentBreakdown: [],
  baseAmount: 0,
  additions: 0,
  grossPayment: 0,
  deductions: 0,
  deductionBreakdown: [],
  panAadhaarStatus: "NOT LINKED",
  netAmount: 0,
  status: "No eligible accrual",
  ...overrides
});

test("a zero payout produces a valid frozen publication snapshot", () => {
  const snapshot = buildWorkforcePayoutPublicationSnapshot(row(), "2026-09-01", "2026-09-30", "version-a");
  assert.equal(snapshot.item.work_days, 0);
  assert.equal(snapshot.item.gross_amount, 0);
  assert.equal(snapshot.item.net_amount, 0);
  assert.deepEqual(snapshot.lines, []);
});

test("the signed row hash ignores unrelated global version churn but detects payout changes", () => {
  const original = row();
  const calculationHash = workforcePayoutCalculationHash(original, "2026-09-01", "2026-09-30");
  assert.match(calculationHash, /^[a-f0-9]{64}$/);
  assert.equal(
    calculationHash,
    workforcePayoutCalculationHash({ ...original }, "2026-09-01", "2026-09-30")
  );
  assert.notEqual(
    workforcePayoutPublicationSnapshotHash(buildWorkforcePayoutPublicationSnapshot(original, "2026-09-01", "2026-09-30", "version-a")),
    workforcePayoutPublicationSnapshotHash(buildWorkforcePayoutPublicationSnapshot(original, "2026-09-01", "2026-09-30", "version-b"))
  );
  assert.notEqual(
    calculationHash,
    workforcePayoutCalculationHash({ ...original, grossPayment: 1, netAmount: 1 }, "2026-09-01", "2026-09-30")
  );
});

test("automatic deduction inputs are ordered before they enter the signed row snapshot", () => {
  const loader = readFileSync(new URL("./workforce-payout-loader.ts", import.meta.url), "utf8");
  assert.match(
    loader,
    /from\("workforce_deduction_heads"\)[\s\S]{0,500}?\.eq\("is_active", true\)\.order\("code"\)\.order\("id"\)/,
    "An unchanged payout must not fail row-fingerprint validation because Postgres returned deduction heads in a different order."
  );
});
