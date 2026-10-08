import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkforcePayoutPublicationSnapshot,
  workforcePayoutCalculationHash,
  workforcePayoutLocationSetHash,
  workforcePayoutPublicationSnapshotHash
} from "./workforce-payout-publication.ts";
import { buildWorkforcePayoutPublicationSnapshot as buildClientSnapshot } from "./workforce-payout-publication-snapshot.ts";
import { revalidateSelectedWorkforcePayoutRows } from "./workforce-payout-selection-revalidation.ts";

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

test("a selected row fingerprint ignores another payout changing but detects a change to the selected payout", () => {
  const selected = row();
  const unrelated = row({
    id: "mapping-2",
    reviewSubjectId: "00000000-0000-4000-8000-000000000012",
    locationId: "00000000-0000-4000-8000-000000000013",
    dropxId: "DROPX2"
  });
  const selectedFingerprint = (rows) => workforcePayoutCalculationHash(
    rows.find((candidate) => candidate.reviewSubjectId === selected.reviewSubjectId),
    "2026-09-01",
    "2026-09-30"
  );
  const calculationHash = selectedFingerprint([selected, unrelated]);
  assert.match(calculationHash, /^[a-f0-9]{64}$/);
  assert.equal(
    calculationHash,
    selectedFingerprint([selected, { ...unrelated, grossPayment: 9999, netAmount: 9999 }]),
    "An unrelated Workforce payout changing must not invalidate the selected row fingerprint."
  );
  assert.notEqual(
    calculationHash,
    selectedFingerprint([{ ...selected, grossPayment: 1, netAmount: 1 }, unrelated]),
    "A changed selected payout must invalidate its signed row fingerprint."
  );
});

test("the frozen publication hash remains dependency-bound for atomic audit storage", () => {
  const original = row();
  assert.notEqual(
    workforcePayoutPublicationSnapshotHash(buildWorkforcePayoutPublicationSnapshot(original, "2026-09-01", "2026-09-30", "version-a")),
    workforcePayoutPublicationSnapshotHash(buildWorkforcePayoutPublicationSnapshot(original, "2026-09-01", "2026-09-30", "version-b"))
  );
});

test("selected payout revalidation accepts unrelated churn and binds the fresh dependency", () => {
  const selected = row();
  const unrelated = row({
    id: "mapping-2",
    reviewSubjectId: "00000000-0000-4000-8000-000000000012",
    locationId: "00000000-0000-4000-8000-000000000013",
    grossPayment: 9999,
    netAmount: 9999
  });
  const result = revalidateSelectedWorkforcePayoutRows({
    dependencyHash: "fresh-global-version",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    rows: [selected, unrelated],
    selections: [{
      subjectId: selected.reviewSubjectId,
      locationId: selected.locationId,
      calculationHash: workforcePayoutCalculationHash(selected, "2026-09-01", "2026-09-30"),
      locationSetHash: workforcePayoutLocationSetHash([selected.locationId])
    }]
  });
  assert.equal(result.error, null);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].snapshot.dependency_hash, "fresh-global-version");
  assert.equal(
    result.entries[0].snapshotHash,
    workforcePayoutPublicationSnapshotHash(result.entries[0].snapshot)
  );
});

test("selected payout revalidation rejects an actual selected-row change", () => {
  const selected = row();
  const result = revalidateSelectedWorkforcePayoutRows({
    dependencyHash: "fresh-global-version",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    rows: [{ ...selected, grossPayment: 1, netAmount: 1 }],
    selections: [{
      subjectId: selected.reviewSubjectId,
      locationId: selected.locationId,
      calculationHash: workforcePayoutCalculationHash(selected, "2026-09-01", "2026-09-30"),
      locationSetHash: workforcePayoutLocationSetHash([selected.locationId])
    }]
  });
  assert.match(result.error, /amounts or payment details changed/i);
  assert.deepEqual(result.entries, []);
});

test("selected payout revalidation rejects a newly added payout location", () => {
  const selected = row();
  const secondLocation = row({ id: "mapping-2", locationId: "00000000-0000-4000-8000-000000000004" });
  const result = revalidateSelectedWorkforcePayoutRows({
    dependencyHash: "fresh-global-version",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    rows: [selected, secondLocation],
    selections: [{
      subjectId: selected.reviewSubjectId,
      locationId: selected.locationId,
      calculationHash: workforcePayoutCalculationHash(selected, "2026-09-01", "2026-09-30"),
      locationSetHash: workforcePayoutLocationSetHash([selected.locationId])
    }]
  });
  assert.match(result.error, /payout locations changed/i);
  assert.deepEqual(result.entries, []);
});

test("the client-safe snapshot builder produces the same immutable publication payload", () => {
  const input = row();
  assert.deepEqual(
    buildClientSnapshot(input, "2026-09-01", "2026-09-30", "version-a"),
    buildWorkforcePayoutPublicationSnapshot(input, "2026-09-01", "2026-09-30", "version-a")
  );
  const source = readFileSync(new URL("./workforce-payout-publication-snapshot.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:crypto|server-only/);
});

test("location-set hashes are stable across order, case and duplicate IDs", () => {
  const first = "00000000-0000-4000-8000-000000000003";
  const second = "00000000-0000-4000-8000-000000000004";
  const expected = workforcePayoutLocationSetHash([first, second]);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(workforcePayoutLocationSetHash([second.toUpperCase(), first, second]), expected);
  assert.notEqual(workforcePayoutLocationSetHash([first]), expected);
});

test("automatic deduction inputs are ordered before they enter the signed row snapshot", () => {
  const loader = readFileSync(new URL("./workforce-payout-loader.ts", import.meta.url), "utf8");
  assert.match(
    loader,
    /from\("workforce_deduction_heads"\)[\s\S]{0,500}?\.eq\("is_active", true\)\.order\("code"\)\.order\("id"\)/,
    "An unchanged payout must not fail row-fingerprint validation because Postgres returned deduction heads in a different order."
  );
});
