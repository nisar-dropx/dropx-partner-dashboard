import assert from "node:assert/strict";
import test from "node:test";
import { lossWorkforcePayable } from "./loss-workforce-payable.ts";
import { allocationError } from "./nl-loss-policy.ts";
import { recoveryPersonPayDisclosure } from "./loss-recovery-pay-privacy.ts";

const row = (overrides = {}) => ({ paymentDetailsAvailable: true, status: "Route distance pending", netAmount: 12431, grossPayment: 12557, ...overrides });
const allowed = ["Ready for review"];

test("RPRN-style fixed pay plus pending route allowance can fund recovery from calculated net only", () => {
  const pay = lossWorkforcePayable([row()], allowed);
  assert.equal(pay.payable, 12431);
  assert.equal(pay.gross, 12557);
  assert.match(pay.source, /pending route allowance excluded/);
  const person = recoveryPersonPayDisclosure({ref:"workforce:1", employee_code:"RPRN20015", full_name:"Fixture", designation:"DA", is_active:true, recovery_limit:pay.payable, salary_gross:pay.gross, salary_source:pay.source});
  assert.equal(allocationError(232.56, [{employee_ref:person.ref, amount:232.56}], [person], true), "");
  assert.match(allocationError(13000, [{employee_ref:person.ref, amount:13000}], [person], true), /more than the available pay/);
});

test("route pending cannot bypass disabled ready-pay policy or actual setup problems", () => {
  assert.equal(lossWorkforcePayable([row()], []).payable, null);
  assert.equal(lossWorkforcePayable([row({paymentDetailsAvailable:false})], allowed).payable, null);
  assert.equal(lossWorkforcePayable([row(), row({status:"Configuration incomplete"})], allowed).payable, null);
  for (const status of ["Payment method not allocated", "Mapping missing", "Unknown status"])
    assert.match(lossWorkforcePayable([row({status})], allowed).source, new RegExp(status));
});

test("unknown amounts stay unavailable, zero stays zero, negative components reduce total pay", () => {
  for (const netAmount of [NaN, Infinity, null]) assert.equal(lossWorkforcePayable([row({netAmount})], allowed).payable, null);
  assert.equal(lossWorkforcePayable([], allowed).payable, null);
  assert.equal(lossWorkforcePayable([row({netAmount:0})], allowed).payable, 0);
  assert.equal(lossWorkforcePayable([row({netAmount:1000}), row({status:"Ready for review",netAmount:-200})], allowed).payable, 800);
});

test("unavailable workforce explanation names the actual blocker", () => {
  const pay=lossWorkforcePayable([row({status:"Configuration incomplete"})], allowed);
  const person=recoveryPersonPayDisclosure({ref:"workforce:1",employee_code:"D1",full_name:"Fixture",designation:"DA",is_active:true,recovery_limit:pay.payable,salary_source:pay.source});
  assert.match(allocationError(100,[{employee_ref:person.ref,amount:100}],[person],true), /Configuration incomplete/);
});
