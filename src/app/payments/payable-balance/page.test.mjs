import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Payable balance is a read-only three-source monthly and all-pending view", () => {
  const page = read("./page.tsx");
  const loader = read("../../../lib/payable-balance-loader.ts");

  assert.match(page, /requirePagePermission\(pageCode, "access"\)/);
  assert.match(page, /AppShell active="Payable balance" pageCode=\{pageCode\}/);
  assert.match(page, /Grand total/);
  assert.match(page, /Paid amount/);
  assert.match(page, /currency\(total\.actualPaidAmount\)/);
  assert.match(page, /Payable balance/);
  assert.match(page, /All months — pending only/);
  assert.match(page, /Pending by month/);
  assert.match(page, /View only/);
  assert.doesNotMatch(page, /<form[^>]+action=\{/);
  assert.doesNotMatch(page, />\s*(Save|Upload|Edit|Delete)\s*</);

  for (const source of ["People Payroll", "Workforce payouts", "Helpers"]) {
    assert.match(page, new RegExp(source));
  }
  assert.match(loader, /workforce_payout_effective_paid_allocations/);
  assert.match(loader, /settled_amount_snapshot/);
  assert.match(loader, /helper_payout_payment_items/);
  assert.match(loader, /settled_amount/);
  assert.match(loader, /hr_payroll_bank_lines/);
  assert.match(loader, /\.eq\("status", "paid"\)/);
  assert.doesNotMatch(loader, /\.from\("(?:payment_requests|expense_claims|expenses)"\)/);
});
