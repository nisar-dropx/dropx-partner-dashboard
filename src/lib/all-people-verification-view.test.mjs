import assert from "node:assert/strict";
import test from "node:test";

import { buildVerificationViewSummary, isExpiredPeopleDate, peopleDateKey } from "./all-people-verification-view.ts";

test("PAN holder summaries use exact, partial, and mismatch colors", () => {
  const cases = [
    ["exact", "success"],
    ["partial", "warning"],
    ["none", "error"]
  ];
  for (const [nameMatchStatus, tone] of cases) {
    assert.deepEqual(buildVerificationViewSummary({
      kind: "pan",
      details: { name: "RAJU MUKIRI", nameMatchStatus }
    }), {
      column: "panNumber",
      summary: { text: "Holder name: RAJU MUKIRI", tone }
    });
  }
});

test("Aadhaar shows only the provider linkage message with linked or unlinked color", () => {
  assert.deepEqual(buildVerificationViewSummary({
    kind: "pan_aadhaar",
    verified: true,
    message: "Pan and Aadhaar Linked"
  }), {
    column: "aadhaarNumber",
    summary: { text: "Pan and Aadhaar Linked", tone: "success" }
  });
  assert.deepEqual(buildVerificationViewSummary({
    kind: "pan_aadhaar",
    verified: false,
    message: "PAN Aadhaar link verification failed."
  }), {
    column: "aadhaarNumber",
    summary: { text: "PAN Aadhaar link verification failed.", tone: "error" }
  });
  assert.equal(buildVerificationViewSummary({
    kind: "pan_aadhaar",
    verified: false,
    message: "Reverification required after profile field update."
  }), null);
});

test("bank, PF, DL, and vehicle summaries include only the requested view details", () => {
  assert.deepEqual(buildVerificationViewSummary({
    kind: "bank",
    message: "Bank account checked.",
    details: { accountName: "ANAND KURUVA" }
  }), {
    column: "bankAccountNumber",
    summary: { text: "Holder name: ANAND KURUVA", tone: "neutral" }
  });
  assert.deepEqual(buildVerificationViewSummary({
    kind: "pf_uan",
    details: { name: "MANOJ PRABHAKAR", nameMatchStatus: "partial" }
  }), {
    column: "pfUan",
    summary: { text: "Holder name: MANOJ PRABHAKAR", tone: "warning" }
  });
  assert.deepEqual(buildVerificationViewSummary({
    kind: "dl",
    details: { name: "AKHIL KS", nameMatchStatus: "none" }
  }), {
    column: "drivingLicenseNumber",
    summary: { text: "Holder name: AKHIL KS", tone: "error" }
  });
  assert.deepEqual(buildVerificationViewSummary({
    kind: "vehicle",
    verified: false,
    details: { ownerName: "RAJU MUKIRI", fuelType: "PETROL", warning: "ignored" }
  }), {
    column: "vehicleRegistrationNumber",
    summary: { text: "RC owner: RAJU MUKIRI · Fuel type: PETROL", tone: "neutral" }
  });
});

test("historical display names provide a fallback without restoring generic status text", () => {
  assert.deepEqual(buildVerificationViewSummary({
    kind: "bank",
    display_name: "HISTORICAL HOLDER",
    verified: true,
    message: "Verified"
  }), {
    column: "bankAccountNumber",
    summary: { text: "Holder name: HISTORICAL HOLDER", tone: "neutral" }
  });
  assert.equal(buildVerificationViewSummary({
    kind: "vehicle",
    details: { invalidated: true, ownerName: "OLD OWNER", fuelType: "DIESEL" }
  }), null);
});

test("vehicle expiry parsing is deterministic for display and ISO dates", () => {
  const today = new Date(2026, 8, 26, 12, 0, 0);
  assert.equal(isExpiredPeopleDate("25/09/2026", today), true);
  assert.equal(isExpiredPeopleDate("2026-09-25", today), true);
  assert.equal(isExpiredPeopleDate("26/09/2026", today), false);
  assert.equal(isExpiredPeopleDate("27/09/2026", today), false);
  assert.equal(isExpiredPeopleDate("31/02/2026", today), false);
  assert.equal(isExpiredPeopleDate("-", today), false);
});

test("the current date uses the business timezone consistently", () => {
  assert.equal(peopleDateKey(new Date("2026-09-25T18:29:00.000Z")), "2026-09-25");
  assert.equal(peopleDateKey(new Date("2026-09-25T18:31:00.000Z")), "2026-09-26");
  assert.equal(isExpiredPeopleDate("25/09/2026", "2026-09-26"), true);
});
