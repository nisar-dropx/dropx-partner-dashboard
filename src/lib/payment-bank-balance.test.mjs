import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { paymentBankBalance } from "./payment-bank-balance.ts";

test("approved totals are preserved while partial credits leave only the remaining balance", () => {
  assert.deepEqual(paymentBankBalance({ amount: 20000, bank_paid_amount: 5000, status: "processing" }),
    { approved: 20000, paid: 5000, remaining: 15000, partial: true });
  assert.deepEqual(paymentBankBalance({ amount: 20000, bank_paid_amount: 20000, status: "processed" }),
    { approved: 20000, paid: 20000, remaining: 0, partial: false });
  assert.equal(paymentBankBalance({ amount: 20000, status: "processed" }).remaining, 0);
  assert.equal(paymentBankBalance({ amount_requested: 20000, status: "approved" }).remaining, 20000);
  assert.equal(paymentBankBalance({ amount: 100.03, bank_paid_amount: 33.34 }).remaining, 66.69);
});

test("the actual bank download exports ₹15,000 after a ₹5,000 credit against ₹20,000", () => {
  const source=readFileSync(new URL("../app/api/payments/process/download/route.ts",import.meta.url),"utf8");
  const mod={exports:{}};
  new Function("require","exports",ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    +"\nexports.rows=fedOneRows;exports.ready=isReadyForPaymentProcess;")((id)=>id==="@/lib/payment-bank-balance"?{paymentBankBalance}:{},mod.exports);
  const request={request_no:"REFERENCE1",amount:20000,bank_paid_amount:5000,status:"processing",approval_status:"PROCESSING",ifsc:"SBIN0000001",bank_account_no:"001234567890"};
  assert.equal(mod.exports.rows([request],"1234567890","07/11/2026")[0]["Transaction Amount"],15000);
  assert.equal(mod.exports.rows([request],"1234567890","07/11/2026")[0]["Unique Customer Reference Number"],"REFERENCE1");
  assert.equal(request.amount,20000);
  assert.equal(mod.exports.ready(request),true);
  assert.equal(mod.exports.ready({...request,bank_paid_amount:20000}),false);
  assert.match(source,/bank_paid_amount,/);
});

test("Process shows Partial Payment and keeps the balance visible in the unpaid queue", () => {
  const source=readFileSync(new URL("../components/payment-process-panel.tsx",import.meta.url),"utf8");
  assert.match(source,/paymentBankBalance\(request\).partial\) return "Partial Payment"/);
  assert.match(source,/status === "approved" && rowStatus === "partial payment"/);
  assert.match(source,/Remaining ·/);
  assert.match(source,/!paymentBankBalance\(processRequest\).partial/);
});
