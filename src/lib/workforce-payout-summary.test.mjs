import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizePaymentMethodAmounts,
  summarizeWorkDays
} from "./workforce-payout-summary.ts";

test("summarizeWorkDays counts full, half and absent biometric days", () => {
  assert.deepEqual(summarizeWorkDays([
    { date: "2026-09-01", attendanceUnit: 1, source: "biometric" },
    { date: "2026-09-02", attendanceUnit: 0.5, source: "biometric" },
    { date: "2026-09-03", attendanceUnit: 0, source: "biometric" }
  ]), { workDays: 1.5, source: "Biometric" });
});

test("summarizeWorkDays keeps shipment threshold results as zero or one", () => {
  assert.deepEqual(summarizeWorkDays([
    { date: "2026-09-01", attendanceUnit: 0, source: "shipment_data" },
    { date: "2026-09-02", attendanceUnit: 1, source: "shipment_data" }
  ]), { workDays: 1, source: "Shipment data" });
});

test("summarizeWorkDays reports an effective source change and does not double-count a date", () => {
  assert.deepEqual(summarizeWorkDays([
    { date: "2026-09-01", attendanceUnit: 0.5, source: "biometric" },
    { date: "2026-09-01", attendanceUnit: 1, source: "biometric" },
    { date: "2026-09-02", attendanceUnit: 1, source: "shipment_data" }
  ]), { workDays: 2, source: "Mixed" });
});

test("summarizePaymentMethodAmounts keeps each mapped method in its own total", () => {
  assert.deepEqual(summarizePaymentMethodAmounts([
    { methodId: "fixed", label: "Fixed Pay", amount: 1000.111 },
    { methodId: "fixed", label: "Fixed Pay", amount: 500.115 },
    { methodId: "mg", label: "Minimum Guarantee", amount: 250 }
  ]), [
    { id: "fixed", label: "Fixed Pay", amount: 1500.23 },
    { id: "mg", label: "Minimum Guarantee", amount: 250 }
  ]);
});
