import assert from "node:assert/strict";
import test from "node:test";
import {
  paymentAllocationDisplayStatus,
  paymentAllocationHistoryRates,
  sortPaymentAllocationHistory,
  uniquePaymentAllocationHistory
} from "./payment-allocation-history.ts";

test("payment history identifies ended, current and scheduled periods", () => {
  assert.equal(paymentAllocationDisplayStatus({ effectiveFrom: "2026-09-01", effectiveTo: "2026-09-05" }, "2026-09-06"), "Ended");
  assert.equal(paymentAllocationDisplayStatus({ effectiveFrom: "2026-09-06", effectiveTo: "" }, "2026-09-06"), "Current");
  assert.equal(paymentAllocationDisplayStatus({ effectiveFrom: "2026-10-01", effectiveTo: "" }, "2026-09-06"), "Scheduled");
  assert.equal(paymentAllocationDisplayStatus({ effectiveFrom: "2026-09-01", effectiveTo: "", storedStatus: "cancelled" }, "2026-09-06"), "Cancelled");
});

test("payment history rates follow configured field order and retain unknown snapshots", () => {
  const rates = paymentAllocationHistoryRates(
    { DELIVERY: 13, CUSTOM_KM: "4.5", CRETURN: 8 },
    [
      { code: "CRETURN", label: "Customer return", sortOrder: 1 },
      { code: "DELIVERY", label: "Delivery", sortOrder: 2 }
    ]
  );
  assert.deepEqual(rates, [
    { code: "CRETURN", label: "Customer return", value: 8 },
    { code: "DELIVERY", label: "Delivery", value: 13 },
    { code: "CUSTOM_KM", label: "CUSTOM_KM", value: 4.5 }
  ]);
});

test("payment history is newest first and de-duplicates records", () => {
  const base = { paymentMethodId: "method", paymentMethodName: "Method", effectiveTo: "", storedStatus: "active", rates: [] };
  const rows = uniquePaymentAllocationHistory([
    { ...base, id: "old", effectiveFrom: "2026-09-01" },
    { ...base, id: "new", effectiveFrom: "2026-09-06" },
    { ...base, id: "new", effectiveFrom: "2026-09-06" }
  ]);
  assert.deepEqual(sortPaymentAllocationHistory(rows).map((row) => row.id), ["new", "old"]);
});
