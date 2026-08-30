import assert from "node:assert/strict";
import test from "node:test";
import { dashboardPaymentDestination } from "./payment-surface-routing.ts";

test("keeps payment creation and operational approval in OpsPulse", () => {
  for (const path of [
    "/payments",
    "/payments/advance-request",
    "/payments/expense-request",
    "/payments/requests",
    "/payments/approvals",
    "/payments/report"
  ]) {
    assert.equal(dashboardPaymentDestination(path)?.product, "operations", path);
  }
});

test("moves finance processing and payment masters to Finance", () => {
  for (const path of [
    "/payments/process",
    "/payments/workforce-payouts",
    "/master/payment-methods",
    "/master/payment-banks",
    "/master/payment-heads",
    "/master/contacts",
    "/settings/payments"
  ]) {
    assert.equal(dashboardPaymentDestination(path)?.product, "finance", path);
  }
});

test("does not claim unrelated portal routes", () => {
  assert.equal(dashboardPaymentDestination("/delivery-network/designations"), null);
});
