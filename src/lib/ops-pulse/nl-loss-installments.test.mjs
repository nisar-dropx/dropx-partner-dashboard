import assert from "node:assert/strict";
import test from "node:test";
import { allocationError, installmentSchedule } from "./nl-loss-policy.ts";

test("full debit is one deduction", () => {
  assert.deepEqual(installmentSchedule(1000, { mode: "full" }), { schedule: [1000], error: "" });
});

test("months basis matches the database: remainder paise on the first instalments", () => {
  assert.deepEqual(installmentSchedule(1000, { mode: "installments", basis: "months", value: "3" }).schedule, [333.34, 333.33, 333.33]);
  assert.deepEqual(installmentSchedule(0.05, { mode: "installments", basis: "months", value: "2" }).error, "The share is too small for 2 instalments.");
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "months", value: "1" }).error, /between 2 and 24/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "months", value: "25" }).error, /between 2 and 24/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "months", value: "2.5" }).error, /between 2 and 24/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "months", value: "" }).error, /number of months/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "months", value: "13" }, 12).error, /between 2 and 12/);
});

test("amount basis ends with the remainder and respects the maximum", () => {
  assert.deepEqual(installmentSchedule(900, { mode: "installments", basis: "amount", value: "400" }).schedule, [400, 400, 100]);
  assert.deepEqual(installmentSchedule(800, { mode: "installments", basis: "amount", value: "400" }).schedule, [400, 400]);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "amount", value: "1000" }).error, /Use Full debit/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "amount", value: "10" }).error, /needs 100 instalments; the maximum is 24/);
  assert.match(installmentSchedule(1000, { mode: "installments", basis: "amount", value: "0.5" }).error, /at least ₹1/);
  assert.match(installmentSchedule(1000, { mode: "installments" , value: "3" }).error, /number of months or by amount/);
});

const person = (extra = {}) => ({ ref: "employee:1", employee_code: "D0001", full_name: "A", designation: "IC", is_active: true, recovery_limit: 500, override_limit: 1000, salary_gross: 1500, ...extra });
const split = (amount) => [{ employee_ref: "employee:1", amount }];

test("the cap applies to the monthly amount, an override to take-home", () => {
  assert.match(allocationError(1200, split(1200), [person()], true, { mode: "full" }, 24, 50), /₹1,200 for D0001 is more than the 50% salary limit of ₹500.*cap override/);
  assert.equal(allocationError(1200, split(1200), [person()], true, { mode: "installments", basis: "months", value: "3" }, 24, 50), "");
  assert.match(allocationError(1200, split(1200), [person()], true, { mode: "full", cap_override: true, cap_override_reason: "short" }), /reason for recovering beyond/);
  assert.match(allocationError(1200, split(1200), [person()], true, { mode: "full", cap_override: true, cap_override_reason: "Approved by finance head" }), /take-home salary limit of ₹1,000/);
  assert.equal(allocationError(900, split(900), [person()], true, { mode: "full", cap_override: true, cap_override_reason: "Approved by finance head" }), "");
  assert.match(allocationError(900, split(900), [person({ recovery_limit: null })], true), /Salary payable is unavailable/);
});

test("the monthly amount never passes gross pay, even with the cap off", () => {
  assert.match(allocationError(2000, split(2000), [person()], false), /more than their gross pay of ₹1,500/);
  assert.equal(allocationError(2000, split(2000), [person()], false, { mode: "installments", basis: "months", value: "2" }), "");
});

test("schedule errors name the person", () => {
  assert.match(allocationError(1000, split(1000), [person()], false, { mode: "installments", basis: "amount", value: "1000" }), /^D0001: .*Full debit/);
});

test("People salary amounts remain server-side while the browser can still submit", () => {
  const restricted = person({ pay_detail_access: "restricted", recovery_limit: undefined, override_limit: undefined, salary_gross: undefined });
  assert.equal(allocationError(1200, split(1200), [restricted], true, { mode: "full" }, 24, 50), "");
});

const thresholds = { installment_thresholds_enabled: true, installment_two_month_min: 7000, installment_three_month_min: 10000, installment_extra_month_step: 5000 };
const unrestrictedPerson = person({salary_gross: undefined});
const check = (amount, months, policy=thresholds) => allocationError(amount, split(amount), [unrestrictedPerson], false, {mode:'installments',basis:'months',value:String(months)},24,50,policy);
test('exclusive per-person recurring amount thresholds, including additional months', () => {
 for (const [amount, months] of [[7000,2],[10000,3],[15000,4],[20000,5]]) {
   assert.match(check(amount,months), /requires a recovery share above/);
   assert.equal(check(amount+0.01,months),'');
 }
 assert.equal(check(10000,2),'');
 assert.equal(check(1_000,2,{...thresholds,installment_thresholds_enabled:false}),'');
 assert.match(check(9000,2,{...thresholds,installment_two_month_min:9500}), /9,500/);
});
test('monthly amount cannot bypass threshold and shipment total does not qualify a smaller share', () => {
 assert.match(allocationError(7000,split(7000),[unrestrictedPerson],false,{mode:'installments',basis:'amount',value:'3500'},24,50,thresholds), /above ₹7,000/);
 const people=[unrestrictedPerson,{...unrestrictedPerson,ref:'employee:2',employee_code:'D0002'}];
 assert.match(allocationError(14000,[{employee_ref:'employee:1',amount:7000},{employee_ref:'employee:2',amount:7000}],people,false,{mode:'installments',basis:'months',value:'2'},24,50,thresholds), /D0001/);
});
