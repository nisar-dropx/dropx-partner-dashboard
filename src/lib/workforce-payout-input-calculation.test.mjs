import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkforcePayoutInputMaps,
  findWorkforcePaymentFieldOverride,
  hasWorkforcePayoutAttendanceOverride,
  overlayWorkforcePayoutAttendance,
  resolveWorkforceCustomProductionUnits,
  resolveWorkforcePaymentFieldRate,
  resolveWorkforcePaymentFieldValue,
  workforcePayoutAttendanceKey
} from "./workforce-payout-input-calculation.ts";

test("attendance imports replace synthesized status and minutes without mutating the source map", () => {
  const absentKey = workforcePayoutAttendanceKey("worker-1", "2026-09-02");
  const zeroMinuteKey = workforcePayoutAttendanceKey("worker-1", "2026-09-03");
  const source = new Map([
    [absentKey, { punch_date: "2026-09-02", status: "P", in_time: "2026-09-02T03:00:00Z", work_minutes: 480 }]
  ]);
  const maps = buildWorkforcePayoutInputMaps({
    attendanceOverrides: [
      { workforce_id: "worker-1", work_date: "2026-09-02", attendance_status: "A", work_minutes: 0 },
      { workforce_id: "worker-1", work_date: "2026-09-03", attendance_status: "P", work_minutes: 0 }
    ]
  });

  const overlaid = overlayWorkforcePayoutAttendance(source, maps.attendanceByWorkforceDate);

  assert.notEqual(overlaid, source);
  assert.equal(source.get(absentKey)?.status, "P");
  assert.equal(overlaid.get(absentKey)?.status, "A");
  assert.equal(overlaid.get(absentKey)?.work_minutes, 0);
  assert.equal(overlaid.has(zeroMinuteKey), true);
  assert.equal(overlaid.get(zeroMinuteKey)?.status, "P");
  assert.equal(overlaid.get(zeroMinuteKey)?.work_minutes, 0);
  assert.equal(hasWorkforcePayoutAttendanceOverride(maps, "worker-1", "2026-09-02"), true);
  assert.equal(hasWorkforcePayoutAttendanceOverride(maps, "worker-1", "2026-09-01"), false);
});

test("an imported blank minute value preserves synthesized biometric minutes", () => {
  const key = workforcePayoutAttendanceKey("worker-1", "2026-09-04");
  const maps = buildWorkforcePayoutInputMaps({
    attendanceOverrides: [
      { workforce_id: "worker-1", work_date: "2026-09-04", attendance_status: "HD", work_minutes: null }
    ]
  });
  const overlaid = overlayWorkforcePayoutAttendance(new Map([
    [key, { punch_date: "2026-09-04", status: "P", work_minutes: 480 }]
  ]), maps.attendanceByWorkforceDate);

  assert.equal(overlaid.get(key)?.status, "HD");
  assert.equal(overlaid.get(key)?.work_minutes, 480);
});

test("payment-field overrides use inclusive intervals and preserve an explicit zero", () => {
  const maps = buildWorkforcePayoutInputMaps({
    paymentFieldOverrides: [
      { id: "first", workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "daily_rate", effective_from: "2026-09-01", effective_to: "2026-09-15", input_value: "0" },
      { id: "second", workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "DAILY_RATE", effective_from: "2026-09-16", effective_to: "2026-09-30", input_value: 750 },
      { id: "other-worker", workforce_id: "worker-2", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "DAILY_RATE", effective_from: "2026-09-01", effective_to: "2026-09-30", input_value: 999 }
    ]
  });

  assert.equal(resolveWorkforcePaymentFieldRate(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "field-1", date: "2026-09-15", fallbackRate: 500
  }), 0);
  assert.equal(resolveWorkforcePaymentFieldRate(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "field-1", date: "2026-09-16", fallbackRate: 500
  }), 750);
  assert.equal(resolveWorkforcePaymentFieldRate(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "field-1", date: "2026-10-01", fallbackRate: 500
  }), 500);
});

test("normalized field code resolves immutable snapshots but a supplied field id remains authoritative", () => {
  const maps = buildWorkforcePayoutInputMaps({
    paymentFieldOverrides: [
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "BASE RATE", effective_from: "2026-09-01", effective_to: "2026-09-30", input_value: 640 }
    ]
  });

  assert.equal(resolveWorkforcePaymentFieldValue(maps, {
    workforceId: "worker-1", stationId: "station-1", fieldCode: " base rate ", date: "2026-09-10", fallbackValue: 500
  }), 640);
  assert.equal(resolveWorkforcePaymentFieldValue(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "another-field", fieldCode: "BASE RATE", date: "2026-09-10", fallbackValue: 500
  }), 500);
});

test("ambiguous overlapping fixture rows fail closed instead of choosing a rate", () => {
  const maps = buildWorkforcePayoutInputMaps({
    paymentFieldOverrides: [
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "RATE", effective_from: "2026-09-01", effective_to: "2026-09-30", input_value: 100 },
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", field_code_snapshot: "RATE", effective_from: "2026-09-10", effective_to: "2026-09-20", input_value: 200 }
    ]
  });

  assert.equal(findWorkforcePaymentFieldOverride(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "field-1", date: "2026-09-15"
  }), undefined);
  assert.equal(resolveWorkforcePaymentFieldRate(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "field-1", date: "2026-09-15", fallbackRate: 75
  }), 75);
});

test("custom production resolves by workforce, field and date and preserves zero units", () => {
  const maps = buildWorkforcePayoutInputMaps({
    customProductionInputs: [
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "custom-field", field_code_snapshot: "EXTRA", work_date: "2026-09-08", units: "0" },
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "custom-field", field_code_snapshot: "EXTRA", work_date: "2026-09-09", units: 12 },
      { workforce_id: "worker-2", station_id: "station-1", payment_field_id: "custom-field", field_code_snapshot: "EXTRA", work_date: "2026-09-08", units: 99 }
    ]
  });

  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "custom-field", date: "2026-09-08", fallbackUnits: 7
  }), 0);
  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", stationId: "station-1", paymentFieldId: "custom-field", date: "2026-09-09", fallbackUnits: 7
  }), 12);
  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", stationId: "station-1", fieldCode: " extra ", date: "2026-09-09", fallbackUnits: 7
  }), 12);
  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", stationId: "station-2", paymentFieldId: "custom-field", date: "2026-09-09", fallbackUnits: 7
  }), 7);
  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", paymentFieldId: "another-field", date: "2026-09-08", fallbackUnits: 7
  }), 7);
  assert.equal(resolveWorkforceCustomProductionUnits(maps, {
    workforceId: "worker-1", paymentFieldId: "custom-field", date: "2026-09-10", fallbackUnits: 7
  }), 7);
});

test("invalid rows never become payout overrides", () => {
  const maps = buildWorkforcePayoutInputMaps({
    attendanceOverrides: [
      { workforce_id: "worker-1", work_date: "2026-02-30", attendance_status: "P", work_minutes: 480 },
      { workforce_id: "worker-1", work_date: "2026-09-01", attendance_status: "UNKNOWN", work_minutes: 480 },
      { workforce_id: "worker-1", work_date: "2026-09-02", attendance_status: "P", work_minutes: 1441 },
      { workforce_id: "worker-1", work_date: "2026-09-03", attendance_status: "HD", work_minutes: 2.5 },
      { workforce_id: "worker-1", work_date: "2026-09-04", attendance_status: "A", work_minutes: 1 }
    ],
    paymentFieldOverrides: [
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", effective_from: "2026-09-30", effective_to: "2026-09-01", input_value: 100 },
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", effective_from: "2026-09-01", effective_to: "2026-09-30", input_value: -1 }
    ],
    customProductionInputs: [
      { workforce_id: "worker-1", station_id: "station-1", payment_field_id: "field-1", work_date: "2026-09-01", units: Number.NaN },
      { workforce_id: "worker-1", station_id: "", payment_field_id: "field-1", work_date: "2026-09-02", units: 1 }
    ]
  });

  assert.equal(maps.attendanceByWorkforceDate.size, 0);
  assert.equal(maps.paymentFieldOverridesByWorkforceField.size, 0);
  assert.equal(maps.customProductionByWorkforceFieldDate.size, 0);
});
