import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { directPayForDay } from "../../../lib/direct-workforce-pay.ts";
import {
  buildReportImportAttendanceByWorkforceDate,
  canonicalWorkforceForMapping,
  createReportImportWorkforceIndex,
  reportImportMappingIdentityGroups,
  reportImportMappingMatchesShipment,
  reportImportMappingStatus,
  selectReportImportMapping
} from "./report-import-attendance.ts";
import {
  allocateReportImportProductionThresholds,
  mergeReportImportShipmentMonthRows,
  reportImportCalendarMonthEnd,
  reportImportShipmentMonthKey
} from "./report-import-production-threshold.ts";

function thresholdShipment(overrides = {}) {
  return {
    client: "Amazon",
    provider_employee_id: "provider-1",
    station_code: "BLR1",
    work_date: "2026-09-01",
    total_delivery: 80,
    source_batch_id: "existing",
    ...overrides
  };
}

function thresholdProduction(overrides = {}) {
  return {
    id: "existing-day",
    workforceId: "worker-1",
    mappingId: "mapping-1",
    date: "2026-09-01",
    effectiveFrom: "2026-09-01",
    effectiveTo: null,
    componentCode: "DELIVERY",
    componentOrder: 1,
    reportedUnits: 80,
    rate: 10,
    thresholdConfig: {
      period: "month",
      component_codes: ["DELIVERY", "CRETURN"],
      minimum_units: 100
    },
    methodThresholdConfig: {
      period: "month",
      component_codes: ["DELIVERY", "CRETURN"]
    },
    ...overrides
  };
}

test("report imports resolve legacy attendance identities through canonical Workforce profiles", () => {
  const index = createReportImportWorkforceIndex([
    { id: "workforce-employee", source_profile_type: "employee", source_profile_id: "employee-1" },
    { id: "workforce-contractor", source_profile_type: "contractor", source_profile_id: "contractor-1" },
    { id: "workforce-executive", source_profile_type: "field_executive", source_profile_id: "executive-1" },
    { id: "workforce-canonical", source_profile_type: "canonical", source_profile_id: "workforce-canonical" }
  ]);

  assert.equal(canonicalWorkforceForMapping({ employee_id: "employee-1" }, index)?.id, "workforce-employee");
  assert.equal(canonicalWorkforceForMapping({ contractor_id: "contractor-1" }, index)?.id, "workforce-contractor");
  assert.equal(canonicalWorkforceForMapping({ field_executive_id: "executive-1" }, index)?.id, "workforce-executive");
  assert.equal(canonicalWorkforceForMapping({ workforce_id: "workforce-canonical" }, index)?.id, "workforce-canonical");

  const attendance = buildReportImportAttendanceByWorkforceDate([
    { id: "legacy-absent", employee_id: "employee-1", punch_date: "2026-09-01", status: "A", work_minutes: 0 },
    { id: "canonical-half", field_executive_id: "workforce-employee", punch_date: "2026-09-01", status: "HD", in_time: "2026-09-01T03:00:00Z", work_minutes: 240 },
    { id: "contractor-present", contractor_id: "contractor-1", punch_date: "2026-09-01", status: "P", work_minutes: 480 },
    { id: "canonical-present", field_executive_id: "workforce-canonical", punch_date: "2026-09-01", status: "P", work_minutes: 480 }
  ], index);

  assert.equal(attendance.get("workforce-employee|2026-09-01")?.id, "canonical-half");
  assert.equal(attendance.get("workforce-contractor|2026-09-01")?.id, "contractor-present");
  assert.equal(attendance.get("workforce-canonical|2026-09-01")?.id, "canonical-present");
});

test("report-import attendance components use daily units, monthly accrual and worked hours", () => {
  const components = [
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day", calculation_type: "fixed_daily", calculation_source: "attendance_eligibility" },
    { component_code: "MONTHLY", component_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: "attendance_eligibility" },
    { component_code: "HOURLY", component_type: "amount", pay_schedule: "per_hour", calculation_type: "fixed_daily", calculation_source: "attendance_eligibility" }
  ];
  const values = { DAILY: 800, MONTHLY: 3000, HOURLY: 100 };
  const present = directPayForDay(values, components, "2026-09-01", { punch_date: "2026-09-01", status: "P", work_minutes: 480 });
  const half = directPayForDay(values, components, "2026-09-02", { punch_date: "2026-09-02", status: "HD", work_minutes: 240 });
  const absent = directPayForDay(values, components, "2026-09-03", { punch_date: "2026-09-03", status: "A", work_minutes: 480 });
  const missing = directPayForDay(values, components, "2026-09-04", null);

  assert.deepEqual(present.lines.map((line) => line.amount), [800, 100, 800]);
  assert.deepEqual(half.lines.map((line) => line.amount), [400, 50, 400]);
  assert.equal(absent.total, 0);
  assert.equal(missing.total, 0);
});

test("report-import components retain nested calculations and historical mapping status", async () => {
  const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(route, /const attendanceCalculation = directPayForDay/);
  assert.match(route, /reportImportMappingStatus\(configured, attendanceConfigurationMissing\)/);
  assert.match(route, /\.eq\("company_id", companyId\)\.in\("status", \["active", "closed"\]\)/);
  assert.match(route, /\.in\(group\.column, group\.ids\.slice/);
  assert.match(route, /\.or\(`effective_to\.is\.null,effective_to\.gte\.\$\{historyFrom\}`\)/);
  assert.match(route, /payment_values,production_threshold_config/);
  assert.match(route, /mergeReportImportShipmentMonthRows/);
  assert.match(route, /allocateReportImportProductionThresholds/);
  assert.match(route, /Combined production minimum missing/);
  assert.match(route, /cpsRecalculationRows = payload\.map/);
});

test("shipment identity matching scopes reused provider IDs by station and provider", () => {
  const scope = {
    stationCodeById: new Map([["station-a", "BLR1"], ["station-b", "BLR2"]]),
    providerLabelsById: new Map([["amazon", ["Amazon", "AMZ"]], ["flipkart", ["Flipkart"]]])
  };
  const shipment = {
    client: "Amazon",
    provider_employee_id: "DA-100",
    station_code: "BLR1",
    work_date: "2026-09-10"
  };
  const base = {
    effective_from: "2026-09-01",
    effective_to: null,
    provider_member_id: "da-100"
  };

  assert.equal(reportImportMappingMatchesShipment({ ...base, provider_id: "amazon", station_id: "station-a" }, shipment, scope), true);
  assert.equal(reportImportMappingMatchesShipment({ ...base, provider_id: "amazon", station_id: "station-b" }, shipment, scope), false);
  assert.equal(reportImportMappingMatchesShipment({ ...base, provider_id: "flipkart", station_id: "station-a" }, shipment, scope), false);

  const workforceIndex = createReportImportWorkforceIndex([
    { id: "worker-a" },
    { id: "worker-b" }
  ]);
  const scoped = selectReportImportMapping([
    { ...base, id: "mapping-b", provider_id: "amazon", station_id: "station-b", workforce_id: "worker-b" },
    { ...base, id: "mapping-a", provider_id: "amazon", station_id: "station-a", workforce_id: "worker-a" }
  ], shipment, scope, workforceIndex);
  assert.equal(scoped.status, "matched");
  assert.equal(scoped.mapping?.id, "mapping-a");

  const conflict = selectReportImportMapping([
    { ...base, id: "mapping-a", provider_id: "amazon", station_id: "station-a", workforce_id: "worker-a" },
    { ...base, id: "mapping-b", provider_id: "amazon", station_id: "station-a", workforce_id: "worker-b" }
  ], shipment, scope, workforceIndex);
  assert.equal(conflict.status, "identity_conflict");
  assert.equal(conflict.mapping, null);
});

test("mapping history expands from canonical identity so an earlier provider ID can be loaded", () => {
  assert.deepEqual(reportImportMappingIdentityGroups([
    { workforce_id: "worker-1", employee_id: "employee-1" },
    { workforce_id: "worker-1", employee_id: "employee-1" }
  ]), [
    { column: "workforce_id", ids: ["worker-1"] },
    { column: "employee_id", ids: ["employee-1"] }
  ]);
});

test("shipment hourly attendance is visibly unavailable instead of mapped at zero", () => {
  const calculation = directPayForDay({ HOURLY: 100 }, [{
    component_code: "HOURLY",
    component_type: "amount",
    pay_schedule: "per_hour",
    calculation_source: "attendance_eligibility"
  }], "2026-09-10", { punch_date: "2026-09-10", status: "P", work_minutes: 0 }, {
    attendanceSource: "shipment_data"
  });

  assert.equal(calculation.total, 0);
  assert.equal(calculation.missing, true);
  assert.equal(reportImportMappingStatus(true, calculation.missing), "Attendance calculation unavailable");
});

test("report import keeps the complete month while incoming rows replace their stored versions", () => {
  const merged = mergeReportImportShipmentMonthRows([
    thresholdShipment(),
    thresholdShipment({ work_date: "2026-09-02", total_delivery: 20 })
  ], [thresholdShipment({ total_delivery: 90, source_batch_id: "incoming" })]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].total_delivery, 90);
  assert.equal(merged[0].source_batch_id, "incoming");
  assert.equal(merged[1].work_date, "2026-09-02");
  assert.equal(reportImportShipmentMonthKey(merged[0]), "2026-09-01|AMAZON|BLR1|PROVIDER-1");
  assert.equal(reportImportCalendarMonthEnd("2028-02-10"), "2028-02-29");
});

test("monthly report-import threshold includes stored earlier rows instead of only the upload slice", () => {
  const allocations = allocateReportImportProductionThresholds([
    thresholdProduction(),
    thresholdProduction({
      id: "uploaded-day",
      date: "2026-09-02",
      componentCode: "CRETURN",
      componentOrder: 2,
      reportedUnits: 30,
      rate: 20
    })
  ]);

  assert.equal(allocations.get("existing-day")?.thresholdDeducted, 80);
  assert.equal(allocations.get("uploaded-day")?.thresholdDeducted, 20);
  assert.equal(allocations.get("uploaded-day")?.payableUnits, 10);
  assert.equal(allocations.get("uploaded-day")?.amount, 200);
});

test("report import fails closed when a threshold method has no person-specific minimum snapshot", () => {
  const allocations = allocateReportImportProductionThresholds([
    thresholdProduction({
      id: "missing-minimum",
      reportedUnits: 25,
      thresholdConfig: null,
      methodThresholdConfig: { period: "day", component_codes: ["DELIVERY"] }
    })
  ]);
  const allocation = allocations.get("missing-minimum");

  assert.equal(allocation?.thresholdConfigurationMissing, true);
  assert.equal(allocation?.payableUnits, 0);
  assert.equal(allocation?.amount, 0);
});
