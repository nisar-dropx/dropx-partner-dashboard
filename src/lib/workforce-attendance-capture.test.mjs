import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  normalizeWorkforceAttendanceCaptureSetting,
  shipmentAttendanceRecord,
  shipmentAttendanceReview,
  shipmentAttendanceUnit,
  workforceAttendanceCaptureSettingForDate
} from "./workforce-attendance-capture.ts";

test("attendance-capture settings normalize to biometric and constrain shipment thresholds", () => {
  assert.deepEqual(normalizeWorkforceAttendanceCaptureSetting(null), {
    id: null,
    capture_method: "biometric",
    minimum_daily_deliveries: null,
    effective_from: "0001-01-01"
  });
  assert.equal(normalizeWorkforceAttendanceCaptureSetting({
    capture_method: "biometric",
    minimum_daily_deliveries: 12,
    effective_from: "2026-10-01"
  }).minimum_daily_deliveries, null);
  assert.equal(normalizeWorkforceAttendanceCaptureSetting({
    capture_method: "shipment_data",
    minimum_daily_deliveries: 12,
    effective_from: "2026-10-01"
  }).minimum_daily_deliveries, 12);
  assert.equal(normalizeWorkforceAttendanceCaptureSetting({
    capture_method: "shipment_data",
    minimum_daily_deliveries: 0,
    effective_from: "not-a-month"
  }).minimum_daily_deliveries, 1);
});

test("attendance-capture settings resolve the latest effective month with biometric fallback", () => {
  const history = [
    { capture_method: "biometric", minimum_daily_deliveries: null, effective_from: "2026-12-01" },
    { capture_method: "shipment_data", minimum_daily_deliveries: 10, effective_from: "2026-10-01" }
  ];

  assert.equal(
    workforceAttendanceCaptureSettingForDate(history, "2026-09-30").capture_method,
    "biometric"
  );
  assert.equal(
    workforceAttendanceCaptureSettingForDate(history, "2026-11-15").minimum_daily_deliveries,
    10
  );
  assert.equal(
    workforceAttendanceCaptureSettingForDate(history, "2026-12-01").capture_method,
    "biometric"
  );
});

test("shipment deliveries aggregate once per canonical workforce and day", () => {
  const totals = aggregateShipmentDeliveriesByWorkforceDay([
    { workforce_id: "worker-1", work_date: "2026-10-05", total_delivery: 4 },
    { workforce_id: "worker-1", work_date: "2026-10-05", total_delivery: "6" },
    { workforce_id: "worker-1", work_date: "2026-10-06", total_delivery: 3 },
    { workforce_id: "worker-2", work_date: "2026-10-05", total_delivery: 8 },
    { workforce_id: null, work_date: "2026-10-05", total_delivery: 100 },
    { workforce_id: "worker-2", work_date: "invalid", total_delivery: 100 },
    { workforce_id: "worker-2", work_date: "2026-10-05", total_delivery: -1 }
  ]);

  assert.deepEqual([...totals.entries()], [
    ["worker-1|2026-10-05", 10],
    ["worker-1|2026-10-06", 3],
    ["worker-2|2026-10-05", 8]
  ]);
});

test("shipment threshold is inclusive and always resolves to one whole attendance unit", () => {
  const setting = {
    capture_method: "shipment_data",
    minimum_daily_deliveries: 10,
    effective_from: "2026-10-01"
  };

  assert.equal(shipmentAttendanceUnit(9, setting), 0);
  assert.equal(shipmentAttendanceUnit(10, setting), 1);
  assert.equal(shipmentAttendanceUnit(25, setting), 1);
  assert.deepEqual(shipmentAttendanceRecord("2026-10-05", 10, setting), {
    punch_date: "2026-10-05",
    status: "P",
    work_minutes: 0
  });
});

 test("low-delivery review does not reduce shipment attendance and is configurable", () => {
 const setting={capture_method:"shipment_data",minimum_daily_deliveries:1,review_below_deliveries:15,effective_from:"2026-09-01"};
 assert.equal(shipmentAttendanceUnit(1,setting),1);assert.equal(shipmentAttendanceUnit(14,setting),1);
 assert.deepEqual(shipmentAttendanceReview(14,setting),{deliveries:14,threshold:15});
 assert.equal(shipmentAttendanceReview(15,setting),null);assert.equal(shipmentAttendanceReview(19,{...setting,review_below_deliveries:20}).threshold,20);
 assert.equal(shipmentAttendanceReview(1,{...setting,review_below_deliveries:null}),null);
 });

test("shipment policy is authoritative and does not fall back to biometric attendance",()=>{
 const policy={capture_method:"shipment_data",minimum_daily_deliveries:1,effective_from:"2026-09-01"};
 const recorded={punch_date:"2026-09-01",status:"HD",work_minutes:240};
 assert.deepEqual(shipmentAttendanceRecord("2026-09-01",0,policy),{
  punch_date:"2026-09-01",status:"A",work_minutes:0
 });
 assert.deepEqual(shipmentAttendanceRecord("2026-09-01",30,policy),{
  punch_date:"2026-09-01",status:"P",work_minutes:0
 });
 assert.equal(recorded.status,"HD");
});
