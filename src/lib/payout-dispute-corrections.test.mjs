import assert from "node:assert/strict";
import test from "node:test";
import { payoutDisputeCorrectionFields, buildDisputeCorrectionPlan } from "./payout-dispute-corrections.ts";
import { encodePayoutDisputeReason, PAYOUT_DISPUTE_AREAS, associatePayoutDispute } from "../../apps/connect/src/lib/payout-dispute.ts";

const snapshot = {
  item: { work_days: 24.5, base_amount: 7600, adjustment_amount: 250, incentive_amount: 100, deduction_amount: 300, net_amount: 7650 },
  worksheet: { production_breakdown: [
    { code: "DAILY_PAY", schedule: "per_day", count: 25, rate: 200, amount: 5000 },
    { code: "DELIVERY", schedule: "per_unit", count: 100, rate: 20, amount: 2000 },
    { code: "DELIVERY", schedule: "per_unit", count: 20, rate: 20, amount: 400 },
    { code: "CRETURN", schedule: "per_unit", count: 5, rate: 20, amount: 100 },
    { code: "PICKUP", schedule: "per_unit", count: 7, rate: 10, amount: 70 },
    { code: "SELLER_PICKUP", schedule: "per_unit", count: 3, rate: 10, amount: 30 },
  ] },
};
const reason = areas => encodePayoutDisputeReason(areas, "Please verify these payout items.");

test("every DropX One checklist item creates its own row from the disputed publication", () => {
  const areas = PAYOUT_DISPUTE_AREAS.map(area => area.value);
  const fields = payoutDisputeCorrectionFields(reason(areas), "other", snapshot);
  assert.equal(fields.length, 10);
  assert.deepEqual(Object.fromEntries(fields.map(field => [field.area, field.currentValue])), {
    work_days: 24.5, attendance_pay: 5000, delivery: 120, customer_return: 5,
    pickup: 7, mfn_seller_pickup: 3, allowances: 250, incentive: 100, deduction: 300, other: 7650,
  });
  assert.deepEqual(payoutDisputeCorrectionFields(reason(["delivery", "customer_return"]), "counts", snapshot).map(field => field.area), ["delivery", "customer_return"]);
});

test("Customer Return survives submission encoding and the approved app projection separately from pickup", () => {
  const fields = payoutDisputeCorrectionFields(reason(["customer_return", "pickup"]), "counts", snapshot);
  const form = new FormData(); form.set("corrected_customer_return", "8"); form.set("corrected_pickup", "9");
  const plan = buildDisputeCorrectionPlan(fields, form);
  const view = associatePayoutDispute({ status: "approved_for_processing", correction_plan: plan });
  assert.deepEqual(view.correction.items.map(item => [item.targetField, item.currentValue, item.proposedValue]), [["Customer Return", 5, 8], ["Pickup", 7, 9]]);
  assert.equal(plan.expected_delta_paise, 8000);
});

test("submitted identities and current values cannot override publication evidence or add unrelated corrections", () => {
  const fields = payoutDisputeCorrectionFields(reason(["delivery", "work_days"]), "other", snapshot);
  const form = new FormData(); form.set("corrected_delivery", "130"); form.set("corrected_work_days", "25");
  form.set("expected_delta_rupees", "999999"); form.set("current_value", "90000"); form.set("target_field", "Deduction"); form.set("corrected_deduction", "0");
  const plan = buildDisputeCorrectionPlan(fields, form);
  assert.deepEqual(plan.items.map(item => [item.area, item.current_value, item.proposed_value]), [["work_days", 24.5, 25], ["delivery", 120, 130]]);
  assert.equal(plan.kind, "other");
  assert.equal(plan.expected_delta_paise, 30000);
});

test("all selected items require corrected values, with zero and decimals preserved", () => {
  const fields = payoutDisputeCorrectionFields(reason(["work_days", "deduction"]), "other", snapshot);
  const form = new FormData(); form.set("corrected_work_days", "25.5");
  assert.throws(() => buildDisputeCorrectionPlan(fields, form), /Deduction/);
  form.set("corrected_deduction", "0");
  assert.equal(buildDisputeCorrectionPlan(fields, form).items[1].proposed_value, 0);
  for (const invalid of ["-1", "NaN", "1e9", "1.001", "", "9007199254740991"]) {
    form.set("corrected_deduction", invalid);
    assert.throws(() => buildDisputeCorrectionPlan(fields, form), /valid corrected value/);
  }
  form.set("corrected_deduction", "0"); form.append("corrected_deduction", "300");
  assert.throws(() => buildDisputeCorrectionPlan(fields, form), /valid corrected value/);
});

test("missing publication values fail closed rather than inventing zero; known empty worksheet counts are zero", () => {
  const missing = payoutDisputeCorrectionFields(reason(["work_days", "customer_return"]), "counts", {});
  assert.ok(missing.every(field => field.currentValue === null));
  assert.throws(() => buildDisputeCorrectionPlan(missing, new FormData(), 0), /unavailable/);
  assert.equal(payoutDisputeCorrectionFields(reason(["customer_return"]), "counts", { worksheet: { production_breakdown: [] } })[0].currentValue, 0);
  assert.equal(payoutDisputeCorrectionFields("Legacy counts discrepancy", "counts", snapshot)[0].currentValue, null);
});

test("legacy daily snapshot counts and different customer-return code aliases remain supported", () => {
  const oldSnapshot = { lines: [
    { calculation_snapshot: { counts: { customerReturn: 5 } } },
    { calculation_snapshot: { counts: { customerReturn: 8 } } },
  ] };
  assert.equal(payoutDisputeCorrectionFields(reason(["customer_return"]), "counts", oldSnapshot)[0].currentValue, 13);
  const aliases = { worksheet: { production_breakdown: [{ code: "C_RETURN", count: 5 }, { code: "CUSTOMER_RETURN", count: 2 }] } };
  assert.equal(payoutDisputeCorrectionFields(reason(["customer_return"]), "counts", aliases)[0].currentValue, 7);
});

test("automatically prices 1000 to 1100 at the published unit rate, ignoring a posted total or rate", () => {
  const published = { worksheet: { production_breakdown: [{ code: "DELIVERY", count: 1000, rate: 20, amount: 20000 }] } };
  const fields = payoutDisputeCorrectionFields(reason(["delivery"]), "counts", published);
  const form = new FormData(); form.set("corrected_delivery", "1100");
  form.set("expected_delta_rupees", "999999"); form.set("unit_rate", "999");
  let plan = buildDisputeCorrectionPlan(fields, form);
  assert.equal(plan.expected_delta_paise, 200000);
  assert.equal(plan.items[0].unit_rate, 20);
  form.set("corrected_delivery", "900");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, -200000);
});

test("combines monetary changes, reverses deduction impact and rounds each item to paise", () => {
  const fields = payoutDisputeCorrectionFields(reason(["delivery", "allowances", "deduction"]), "other", snapshot);
  const form = new FormData(); form.set("corrected_delivery", "120.01"); form.set("corrected_allowances", "300.25"); form.set("corrected_deduction", "200");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, 15045);
  form.set("corrected_deduction", "400");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, -4955);
});

test("half-paise quantity changes round symmetrically for increases and decreases", () => {
  const fields = payoutDisputeCorrectionFields(reason(["delivery"]), "counts", { worksheet: { production_breakdown: [{ code: "DELIVERY", count: 10, rate: 2.5 }] } });
  const form = new FormData(); form.set("corrected_delivery", "10.01");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, 3);
  form.set("corrected_delivery", "9.99");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, -3);
});

test("uses zero rates, and blocks guessing missing or differing unit rates when a quantity changes", () => {
  for (const lines of [
    [{ code: "DELIVERY", count: 10, amount: 100 }],
    [{ code: "DELIVERY", count: 5, rate: 10 }, { code: "DELIVERY", count: 5, rate: 20 }],
  ]) {
    const fields = payoutDisputeCorrectionFields(reason(["delivery"]), "counts", { worksheet: { production_breakdown: lines } });
    const form = new FormData(); form.set("corrected_delivery", "11");
    assert.throws(() => buildDisputeCorrectionPlan(fields, form), /single unit rate/);
    form.set("corrected_delivery", "10");
    assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, 0);
  }
  const zero = payoutDisputeCorrectionFields(reason(["delivery"]), "counts", { worksheet: { production_breakdown: [{ code: "DELIVERY", count: 10, rate: 0 }] } });
  const form = new FormData(); form.set("corrected_delivery", "11");
  assert.equal(buildDisputeCorrectionPlan(zero, form).expected_delta_paise, 0);
});

test("daily attendance uses its published daily rates; ambiguous monthly/hourly attendance is not guessed", () => {
  const fields = payoutDisputeCorrectionFields(reason(["work_days"]), "training", { item: { work_days: 10 }, worksheet: { production_breakdown: [
    { code: "DAILY", schedule: "per_day", count: 10, rate: 500 },
    { code: "DAY_ALLOWANCE", schedule: "per_day", count: 10, rate: 100 },
  ] } });
  const form = new FormData(); form.set("corrected_work_days", "11.5");
  assert.equal(buildDisputeCorrectionPlan(fields, form).expected_delta_paise, 90000);
  for (const schedule of ["per_month", "per_hour"]) {
    const ambiguous = payoutDisputeCorrectionFields(reason(["work_days"]), "training", { item: { work_days: 10 }, worksheet: { production_breakdown: [{ code: "SALARY", schedule, count: 10, rate: 500 }] } });
    assert.throws(() => buildDisputeCorrectionPlan(ambiguous, form), /No single daily rate/);
  }
});

test("overlapping attendance and total-pay corrections cannot double count the same change", () => {
  const fields = payoutDisputeCorrectionFields(reason(["work_days", "attendance_pay"]), "training", snapshot);
  const form = new FormData(); form.set("corrected_work_days", "25"); form.set("corrected_attendance_pay", "5100");
  assert.throws(() => buildDisputeCorrectionPlan(fields, form), /overlap/);
  const net = payoutDisputeCorrectionFields(reason(["other", "deduction"]), "other", snapshot);
  form.set("corrected_other", "8000"); form.set("corrected_deduction", "0");
  assert.throws(() => buildDisputeCorrectionPlan(net, form), /overlap/);
});
