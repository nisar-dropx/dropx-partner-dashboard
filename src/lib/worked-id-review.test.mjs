import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  workedIdCounts,
  workedIdShareError,
  workedIdMonth,
  hasWorkedIdFixedSalary,
  workedIdDeliveryRoles,
  workedIdErrorMessage,
} from "./worked-id-review.ts";
test("upstream HTML is replaced by a short recovery message while review errors remain specific", () => {
  assert.equal(workedIdErrorMessage(new Error('<!DOCTYPE html><html><title>525 SSL handshake failed</title></html>'), 'Failed'),
    'The database connection is temporarily unavailable. Refresh and try again.');
  assert.equal(workedIdErrorMessage(new Error('Only the assigned Cluster Manager may approve.'), 'Failed'),
    'Only the assigned Cluster Manager may approve.');
});
test("only salary/MG qualifies, never rent, ODCD variable, fuel, zero rates or excluded roles", () => {
  const c = (code) => ({
    component_code: code,
    component_type: "amount",
    is_active: true,
    pay_schedule: "per_day",
  });
  for (const code of [
    "MG_PER_DAY",
    "MG_PER_MONTH",
    "FIXED_PAY_PER_DAY",
    "FIXED_PAY_PER_MONTH",
  ])
    assert.equal(hasWorkedIdFixedSalary([c(code)], { [code]: 1000 }), true);
  for (const code of [
    "VAN_RENT_PER_DAY",
    "VAN_RENT_PER_MONTH",
    "ODCD",
    "FUEL",
    "KM_RUN",
    "DELIVERY",
  ])
    assert.equal(hasWorkedIdFixedSalary([c(code)], { [code]: 1000 }), false);
  assert.equal(
    hasWorkedIdFixedSalary([c("MG_PER_DAY")], { MG_PER_DAY: 0 }),
    false,
  );
  assert.equal(
    hasWorkedIdFixedSalary([{ ...c("MG_PER_DAY"), is_active: false }], {
      MG_PER_DAY: 1000,
    }),
    false,
  );
  assert.equal(
    hasWorkedIdFixedSalary(
      [{ ...c("MG_PER_DAY"), component_type: "production" }],
      { MG_PER_DAY: 1000 },
    ),
    false,
  );
  assert.deepEqual(workedIdDeliveryRoles, ["DA", "DCD", "ODCD", "WM"]);
});
test("a shared day requires an explicit owner answer and conserved whole counts", () => {
  const available = workedIdCounts({
    total_delivery: 10,
    amazon_delivery: 8,
    swa_delivery: 2,
    delivery_assigned_count: 12,
  });
  assert.match(workedIdShareError(available, available, null), /Confirm/);
  assert.equal(workedIdShareError(available, available, false), null);
  assert.match(
    workedIdShareError(available, { ...available, total_delivery: 5 }, false),
    /all remaining/,
  );
  assert.match(
    workedIdShareError(available, { ...available, total_delivery: 11 }, true),
    /between/,
  );
  assert.match(
    workedIdShareError(available, { ...available, total_delivery: 5.5 }, true),
    /whole/,
  );
  assert.match(
    workedIdShareError(available, { ...available, total_delivery: 5 }, true),
    /Amazon plus SWA/,
  );
  assert.equal(
    workedIdShareError(
      available,
      {
        ...available,
        total_delivery: 5,
        amazon_delivery: 4,
        swa_delivery: 1,
        delivery_assigned_count: 6,
      },
      true,
    ),
    null,
  );
  assert.deepEqual(workedIdMonth("2026-10"), {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.throws(() => workedIdMonth("2026-13"), /valid month/);
});
test("all financial readers use reviewed facts; operational evidence remains raw", () => {
  for (const path of [
    "src/lib/workforce-payout-loader.ts",
    "apps/connect/app/api/connect/earnings/route.ts",
    "apps/connect/app/api/connect/workforce-payments/route.ts",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /from\("workforce_payout_shipment_facts"\)/, path);
    assert.match(source, /from\("workforce_payout_attendance_facts"\)/, path);
    assert.doesNotMatch(
      source,
      /from\(["'](?:cps_shipment_daily|attendance_daily)["']\)/,
      path,
    );
  }
  assert.match(
    readFileSync(
      "apps/connect/src/lib/direct-workforce-payment-data.ts",
      "utf8",
    ),
    /workforce_payout_attendance_facts/,
  );
  assert.match(
    readFileSync("src/lib/ops-pulse/cps-snapshot.ts", "utf8"),
    /workforce_payout_attendance_facts/,
  );
  assert.match(
    readFileSync("src/lib/worked-id-review-data.ts", "utf8"),
    /\.from\("attendance_punches"\)/,
  );
});

test("combined Delivery splits conserve Amazon/SWA and all four payment categories", async () => {
  const { workedIdPaymentMetrics, updateWorkedIdPaymentShare } = await import("./worked-id-review.ts");
  assert.deepEqual(workedIdPaymentMetrics, ["total_delivery", "c_return", "mfn", "mfn_return"]);
  const source = workedIdCounts({ total_delivery: 37, amazon_delivery: 36, swa_delivery: 1,
    c_return: 2, mfn: 3, mfn_return: 1, assigned_count: 50,
    delivery_assigned_count: 42, pickup_assigned_count: 8 });
  for (let deliveries = 1; deliveries <= 37; deliveries++) {
    let allocated = workedIdCounts({});
    for (const [metric, value] of [["total_delivery", deliveries], ["c_return", 1], ["mfn", 2], ["mfn_return", 1]])
      allocated = updateWorkedIdPaymentShare(source, allocated, metric, value);
    assert.equal(workedIdShareError(source, allocated, true), null);
    assert.equal(allocated.amazon_delivery + allocated.swa_delivery, deliveries);
    const remaining = workedIdCounts(Object.fromEntries(Object.keys(source).map(k => [k, source[k] - allocated[k]])));
    if (remaining.total_delivery) {
      let second = workedIdCounts({});
      for (const metric of workedIdPaymentMetrics)
        second = updateWorkedIdPaymentShare(remaining, second, metric, remaining[metric]);
      assert.equal(workedIdShareError(remaining, second, false), null);
      for (const metric of Object.keys(source)) assert.equal(allocated[metric] + second[metric], source[metric]);
    }
  }
});

test("editing returns preserves a saved delivery split; invalid counts remain blocked", async () => {
  const { updateWorkedIdPaymentShare } = await import("./worked-id-review.ts");
  const source = workedIdCounts({ total_delivery: 37, amazon_delivery: 36, swa_delivery: 1, c_return: 2 });
  const previous = workedIdCounts({ total_delivery: 10, amazon_delivery: 9, swa_delivery: 1 });
  const revised = updateWorkedIdPaymentShare(source, previous, "c_return", 1);
  assert.equal(revised.amazon_delivery, 9);
  assert.equal(revised.swa_delivery, 1);
  assert.equal(workedIdShareError(source, revised, true), null);
  for (const value of [-1, 38, 1.5, NaN])
    assert.match(workedIdShareError(source, updateWorkedIdPaymentShare(source, previous, "total_delivery", value), true), /whole/);
});
