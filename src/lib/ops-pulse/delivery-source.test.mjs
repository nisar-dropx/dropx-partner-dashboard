import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAmazonDeliveryRows, totalAmazonDeliveryRows } from "./delivery-source.ts";

const row = (overrides = {}) => ({
  station_code: "KGQA",
  work_date: "2026-08-05",
  provider_employee_id: "DA-1",
  base_amazon_delivery: 659,
  smd_delivery: 0,
  smd2_delivery: 0,
  swa_delivery: 25,
  c_return: 32,
  mfn: 49,
  mfn_return: 1,
  ...overrides
});

test("uses only Amazon Daily Shipment Count rows and the configured workload formula", () => {
  const [day] = summarizeAmazonDeliveryRows([row()]);
  assert.equal(day.workDate, "2026-08-05");
  assert.equal(day.activeIds, 1);
  assert.equal(day.totals.amazon, 659);
  assert.equal(day.totals.swa, 25);
  assert.equal(day.totals.returned, 32);
  assert.equal(day.totals.workload, 716);
});

test("does not invent missing 6 or 7 August dates", () => {
  const days = summarizeAmazonDeliveryRows([
    row({ work_date: "2026-08-02" }),
    row({ work_date: "2026-08-03" }),
    row({ work_date: "2026-08-04" }),
    row({ work_date: "2026-08-05" })
  ]);
  assert.deepEqual(days.map((day) => day.workDate), ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
});

test("counts distinct Road IDs from the uploaded Amazon rows", () => {
  const [day] = summarizeAmazonDeliveryRows([
    row({ provider_employee_id: "DA-1", base_amazon_delivery: 300, swa_delivery: 0, c_return: 0 }),
    row({ provider_employee_id: "DA-1", base_amazon_delivery: 359, swa_delivery: 0, c_return: 0 }),
    row({ provider_employee_id: "DA-2", base_amazon_delivery: 0, swa_delivery: 25, c_return: 32 })
  ]);
  assert.equal(day.activeIds, 2);
  assert.equal(day.totals.workload, 716);
});

test("keeps MFN reference metrics outside capacity workload", () => {
  const totals = totalAmazonDeliveryRows([row()]);
  assert.equal(totals.mfn, 49);
  assert.equal(totals.mfnReturn, 1);
  assert.equal(totals.workload, 716);
});
