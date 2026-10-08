import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publishedPayoutBreakdown } from "./published-payout-breakdown.ts";

test("published worksheet keeps only configured payment heads and itemized non-zero additions and deductions", () => {
  const result = publishedPayoutBreakdown({
    worksheet: {
      work_days_source: "Biometric",
      production_breakdown: [
        { code: "DELIVERY", label: "Delivery", componentType: "production", schedule: "per_unit", count: 100, rate: 13, amount: 1300, sortOrder: 2 },
        { code: "MONTHLY_PAY", label: "Monthly pay", componentType: "amount", schedule: "per_month", count: 0.5, rate: 12000, amount: 6000, sortOrder: 1 },
        { code: "SELLER_RETURN", label: "Seller return", componentType: "production", schedule: "per_unit", count: 0, rate: 3, amount: 0, sortOrder: 3 },
      ],
      additional_payment_breakdown: [
        { fieldId: "bonus", code: "BONUS", label: "Performance bonus", calculationType: "manual_amount", amount: 500 },
        { fieldId: "unused", code: "UNUSED", label: "Unused", calculationType: "manual_amount", amount: 0 },
      ],
      deduction_breakdown: [
        { code: "TDS", label: "TDS", amount: 78 },
        { code: "ADVANCE", label: "Advance", amount: 1000 },
        { code: "ZERO", label: "Unused deduction", amount: 0 },
      ],
      daily_breakdown: [{ attendanceRange: { basis: "days", quantity: 15, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" } }],
    },
  }, [], { deduction_amount: 1078 });

  assert.deepEqual(result.earnings.map(({ code, basis, amount }) => ({ code, basis, amount })), [
    { code: "MONTHLY_PAY", basis: "per_month", amount: 6000 },
    { code: "DELIVERY", basis: "per_unit", amount: 1300 },
    { code: "SELLER_RETURN", basis: "per_unit", amount: 0 },
    { code: "BONUS", basis: "additional", amount: 500 },
  ]);
  assert.deepEqual(result.deductions, [
    { code: "TDS", label: "TDS", amount: 78 },
    { code: "ADVANCE", label: "Advance", amount: 1000 },
  ]);
  assert.equal(result.attendanceSource, "Biometric");
  assert.deepEqual(result.attendanceRanges, [{ basis: "days", quantity: 15, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" }]);
});

test("legacy line snapshots aggregate payment heads without exposing a daily report", () => {
  const result = publishedPayoutBreakdown(null, [
    { source_type: "worksheet", calculation_snapshot: { attendanceSource: "Shipment data", paymentLines: [{ code: "DELIVERY", label: "Delivery", componentType: "production", count: 5, rate: 13, amount: 65 }] } },
    { source_type: "worksheet", calculation_snapshot: { paymentLines: [{ code: "DELIVERY", label: "Delivery", componentType: "production", count: 7, rate: 13, amount: 91 }] } },
    { source_type: "additional_payment", adjustment_amount: 250, calculation_snapshot: { category: "BONUS", reason: "Bonus", calculationType: "manual_amount" } },
    { source_type: "deduction", adjustment_amount: -16, calculation_snapshot: { category: "TDS", reason: "TDS" } },
  ], {});

  assert.deepEqual(result.earnings.map(({ code, units, rate, amount }) => ({ code, units, rate, amount })), [
    { code: "DELIVERY", units: 12, rate: 13, amount: 156 },
    { code: "BONUS", units: null, rate: null, amount: 250 },
  ]);
  assert.deepEqual(result.deductions, [{ code: "TDS", label: "TDS", amount: 16 }]);
  assert.equal(result.attendanceSource, "Shipment data");
});

test("monthly payout UI is one consolidated view and does not duplicate live daily earnings", () => {
  const source = readFileSync(new URL("../components/associate-payouts.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../components/associate-payouts.module.css", import.meta.url), "utf8");
  assert.match(source, /Attendance used for this payout/);
  assert.match(source, /Payment heads/);
  assert.match(source, /Deduction heads/);
  assert.match(source, /Monthly amount/);
  assert.match(source, /role="region"[\s\S]*aria-label="Payment details table\. Scroll horizontally to view all columns\."[\s\S]*tabIndex=\{0\}[\s\S]*aria-label="Payment heads breakdown"/);
  assert.match(source, /aria-label="Payment heads breakdown"[\s\S]*<thead><tr><th scope="col">Payment head<\/th><th scope="col">Units<\/th><th scope="col">Rate<\/th><th scope="col">Amount<\/th><\/tr><\/thead>/);
  assert.match(source, /aria-label="Payment heads breakdown"[\s\S]*<tfoot><tr><th scope="row" colSpan=\{3\}>Gross earnings<\/th><td>\{money\(payout\.gross\)\}<\/td><\/tr><\/tfoot>/);
  assert.match(source, /aria-label="Deduction heads breakdown"[\s\S]*<th scope="col">Deduction<\/th><th scope="col">Amount<\/th>[\s\S]*Gross deductions/);
  assert.match(source, /aria-label="Payout totals"[\s\S]*Gross earnings[\s\S]*Gross deductions[\s\S]*Net payable/);
  assert.match(source, /aria-label="Final net payable"[\s\S]*Gross earnings minus gross deductions[\s\S]*Net payable/);
  assert.match(styles, /\.breakdownTable[\s\S]*table-layout:\s*fixed/);
  assert.match(styles, /\.tableWrap:focus-visible[\s\S]*outline:/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.breakdownTable/);
  assert.doesNotMatch(styles, /@media \(max-width: 420px\)[\s\S]*\.basisNote\s*\{[\s\S]*display:\s*none/);
  assert.match(source, /line\.basis === "per_unit"[\s\S]*label: "Per unit"[\s\S]*label: "Configured rate"/);
  assert.doesNotMatch(source, /tab === ["']daily["']|Finalized payout details|<th>Date \/ ID<\/th>|className=\{styles\.paymentLine\}/);
});

test("payment information contains bank details only", () => {
  const source = readFileSync(new URL("../components/associate-payouts.tsx", import.meta.url), "utf8");
  const start = source.indexOf("<h3>Payment information</h3>");
  const end = source.indexOf("</section>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const paymentInformation = source.slice(start, end);
  assert.match(paymentInformation, /aria-label="Bank details"/);
  assert.match(paymentInformation, /Bank account/);
  assert.match(paymentInformation, /IFSC/);
  assert.doesNotMatch(paymentInformation, /payout\.(?:dropxId|name|station|providerIds|paymentReference|paymentDate)/);
});

test("payout disputes stay with Workforce and the associate view has no conversation or reply controls", () => {
  const component = readFileSync(new URL("../components/associate-payouts.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../components/associate-payouts.module.css", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/connect/payout-review/route.ts", import.meta.url), "utf8");
  const loader = readFileSync(new URL("./associate-payouts.ts", import.meta.url), "utf8");

  assert.match(component, /Dispute sent to Workforce for review\./);
  assert.match(component, /operation: ["']create["']/);
  assert.match(component, /aria-controls="payout-dispute-section"[\s\S]*onClick=\{toggleDisputeSection\}/);
  assert.match(component, /ref=\{disputeSectionRef\} id="payout-dispute-section"[\s\S]*tabIndex=\{-1\} aria-labelledby="payout-dispute-heading"/);
  assert.match(component, /id="payout-dispute-heading"[\s\S]*Raise a dispute/);
  assert.match(component, /useEffect\(\(\) => \{\s*if \(!showDisputes\) return;[\s\S]*disputeSectionRef\.current\?\.focus\(\{ preventScroll: true \}\)[\s\S]*scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)[\s\S]*\}, \[showDisputes\]\)/);
  assert.match(styles, /\.disputes[\s\S]*scroll-margin-top:\s*88px/);
  assert.doesNotMatch(component, /Dispute a deduction|openDeductionDispute|setDisputeAreas\(\["deduction"\]\)|station team|Send reply|event\.actor_name|operation: disputeId \? ["']reply["']/i);

  assert.match(route, /body\.operation\s*!==\s*["']create["']/);
  assert.doesNotMatch(route, /workforce_reply_payout_dispute|ownOpenDispute/);
  assert.doesNotMatch(loader, /workforce_payout_dispute_events/);
});
