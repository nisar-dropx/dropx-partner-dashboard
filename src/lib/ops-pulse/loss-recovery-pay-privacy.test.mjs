import assert from "node:assert/strict";
import test from "node:test";
import {
  privacySafeRecoveryError,
  recoveryPersonPayDisclosure,
  redactRecoverySnapshot,
} from "./loss-recovery-pay-privacy.ts";

const pay = {
  salary_payable: 40000,
  salary_gross: 50000,
  salary_source: "People payroll",
  recovery_limit: 10000,
  override_limit: 40000,
  reserved: 1000,
};
const person = (ref) => ({ ref, employee_code: "D1", full_name: "A", designation: "DA", is_active: true, ...pay });

test("People recovery targets defer salary checks to payroll and expose no salary amounts", () => {
  const disclosed = recoveryPersonPayDisclosure(person("employee:1"));
  assert.equal(disclosed.pay_detail_access, "restricted");
  assert.equal(disclosed.pay_check_state, "payroll");
  for (const key of Object.keys(pay)) assert.equal(Object.hasOwn(disclosed, key), false, key);
});

test("Workforce recovery targets retain payout details", () => {
  const disclosed = recoveryPersonPayDisclosure(person("workforce:1"));
  assert.equal(disclosed.pay_detail_access, "workforce");
  assert.equal(disclosed.salary_payable, 40000);
  assert.equal(disclosed.recovery_limit, 10000);
});

test("recovery history redacts People pay but keeps operational schedule data", () => {
  const snapshot = redactRecoverySnapshot({ allocations: [
    { ...person("employee:1"), amount: 1000, monthly_amount: 500, installments: [{ n: 1, amount: 500 }] },
    { ...person("workforce:1"), amount: 500 },
  ] });
  assert.equal(Object.hasOwn(snapshot.allocations[0], "salary_payable"), false);
  assert.equal(snapshot.allocations[0].monthly_amount, 500);
  assert.equal(snapshot.allocations[1].salary_payable, 40000);
});

test("People salary validation errors never disclose monetary values", () => {
  const exposed = "The monthly recovery of ₹12,000 for D1 is more than the 25% salary limit of ₹10,000.";
  const safe = privacySafeRecoveryError(exposed, true);
  assert.match(safe, /exceeds available pay/);
  assert.doesNotMatch(safe, /override/);
  assert.doesNotMatch(safe, /₹|12,000|10,000|25%/);
  assert.equal(privacySafeRecoveryError(exposed, false), exposed);
});

test("missing People payroll does not expose an unavailable-salary warning", () => {
  const disclosed = recoveryPersonPayDisclosure({ ...person("contractor:1"), recovery_limit: null });
  assert.equal(disclosed.pay_check_state, "payroll");
  assert.equal(Object.hasOwn(disclosed, "salary_payable"), false);
});


test("former People show recovery capacity without exposing salary breakdown", () => {
  const disclosed=recoveryPersonPayDisclosure({...person("employee:1"),is_active:false,unpaid_payroll_check:true,salary_month:"2026-09"});
  assert.equal(disclosed.pay_detail_access,"recovery_limit");
  assert.equal(disclosed.recovery_limit,10000);
  assert.equal(disclosed.salary_month,"2026-09");
  for(const key of ["salary_gross","salary_payable","reserved","salary_source","override_limit"]) assert.equal(Object.hasOwn(disclosed,key),false);
});
