import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./payment-approval-amount.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
new Function("exports", "module", code)(module.exports, module);
const { paymentApprovalAmount } = module.exports;

test("new expense estimates appear even before an actual payment amount exists", () => {
  for (const amount of [500, 1500, 2200, 1800, 1900, 700]) {
    const request = Object.freeze({ amount: null, amount_requested: amount });
    assert.deepEqual(paymentApprovalAmount(request), {
      text: `Rs ${amount.toLocaleString("en-IN")}`, isEstimated: true
    });
  }
  assert.deepEqual(paymentApprovalAmount({ amount: null, amount_requested: "1500.00" }), { text: "Rs 1,500", isEstimated: true });
});

test("actual amounts take precedence; zeros and missing values remain distinct", () => {
  assert.deepEqual(paymentApprovalAmount({ amount: 400, amount_requested: 500 }), { text: "Rs 400", isEstimated: false });
  assert.deepEqual(paymentApprovalAmount({ amount: 0, amount_requested: 500 }), { text: "Rs 0", isEstimated: false });
  assert.deepEqual(paymentApprovalAmount({ amount: null, amount_requested: 0 }), { text: "Rs 0", isEstimated: true });
  assert.deepEqual(paymentApprovalAmount({ amount: null, amount_requested: null }), { text: "-", isEstimated: false });
});

test("approval list and instant review use the same display rule and label estimates", () => {
  const page = readFileSync(new URL("../app/payments/approvals/page.tsx", import.meta.url), "utf8");
  const review = readFileSync(new URL("../components/payment-approval-review-launcher.tsx", import.meta.url), "utf8");
  assert.match(page, /const displayAmount = paymentApprovalAmount\(request\)/);
  assert.match(page, /amountEstimated: displayAmount\.isEstimated/);
  assert.match(page, /amountText: displayAmount\.text/);
  assert.match(page, /displayAmount\.text/);
  assert.match(page, /displayAmount\.isEstimated \? <small[^>]*>Estimated<\/small>/);
  assert.match(review, /summary\.amountEstimated \? "Estimated amount" : "Amount"/);
  assert.match(review, /<strong>\{summary\.amountText\}<\/strong>/);
  assert.doesNotMatch(page, /<td>\{request\.amount == null \? "-"/);
});
