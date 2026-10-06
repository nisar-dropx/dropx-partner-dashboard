import "server-only";



import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";

import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { calculateAutomaticDeductionLines, type AutomaticDeductionHead, type DeductionWorkerContext } from "@/lib/workforce-deductions";
import { allocationActiveOn, cumulativeDirectPayUnitsBefore, directPayAttendanceBasis, directPayAttendanceUnit, directPayForDay, preferredDirectPayAttendance, type DirectPayComponent } from "@/lib/direct-workforce-pay";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { readAllRows } from "@/lib/supabase-pagination";
import { workforcePaymentMonthStart, workforcePaymentPolicyForDate, type WorkforcePaymentPolicy } from "@/lib/workforce-payment-policy";
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  shipmentAttendanceRecord,
  workforceAttendanceCaptureSettingForDate,
  type WorkforceAttendanceCaptureSetting
} from "@/lib/workforce-attendance-capture";
import {
  attendanceCaptureLabel,
  summarizePaymentMethodAmounts,
  summarizePayoutBreakdownLines,
  summarizeWorkDays
} from "@/lib/workforce-payout-summary";
import { normalizePaymentFieldCode, paymentComponentOrderMap, sortByPaymentFieldOrder } from "@/lib/payment-field-order";
import { paymentAllocationHistoryRates, sortPaymentAllocationHistory, type PaymentAllocationHistoryEntry } from "@/lib/payment-allocation-history";
import { consolidateProviderPayoutSegments, type ProviderPayoutSegment } from "@/lib/provider-payout-consolidation";
import { parseProductionThresholdSnapshot } from "@/lib/production-threshold-snapshot";
import { allocateCombinedProductionThresholds } from "@/lib/workforce-production-threshold";
import {
  workforceAdditionalPaymentLines,
  workforceAdditionalPaymentTotal,
  type WorkforceAdditionalPaymentField,
  type WorkforceAdditionalPaymentValue
} from "@/lib/workforce-additional-payment-overlay";
import {
  resolveWorkforcePayoutDeductionContext,
  workforcePayoutDeductionLines,
  workforcePayoutDeductionTotal,
  type WorkforcePayoutDeductionValue
} from "@/lib/workforce-deduction-overlay";
import {
  buildWorkforcePayoutInputMaps,
  aggregateAttendanceIssueAffectsPayoutPeriod,
  findWorkforcePayoutAttendancePeriod,
  hasWorkforcePayoutAttendanceOverride,
  overlayWorkforcePayoutAttendance,
  resolveWorkforceCustomProductionUnits,
  resolveWorkforcePaymentFieldRate
} from "@/lib/workforce-payout-input-calculation";
import { groupPayoutItemsBySubjectLocation, payoutSubjectLocationKey } from "@/lib/workforce-payout-location-groups";
import {
  mappingsForAuthorizedWorkforce,
  normalizePayoutIdentity,
  payoutMappingMatchesShipment,
  resolveShipmentPayoutMapping,
  shipmentIdentityKey,
  workforcePayoutDropxStatus,
  type WorkforcePayoutMappingIdentity
} from "@/lib/workforce-payout-population";


const today = todayKolkata;
const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";
const metricValue = (row: any, source: string) => source === "amazon_delivery" ? Number(row.amazon_delivery ?? 0)
  : source === "swa_delivery" ? Number(row.swa_delivery ?? 0)
  : source === "total_delivery" ? Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)))
  : source === "customer_return" ? Number(row.c_return ?? 0)
  : source === "seller_pickup" ? Number(row.mfn ?? 0)
  : source === "seller_return" ? Number(row.mfn_return ?? 0)
  : 0;
const productionLabel = (code: string, fallback: string) => code === "DELIVERY" ? "Delivery"
  : code === "CRETURN" ? "C-return"
  : code === "SELLER_PICKUP" ? "MFN"
  : code === "SLLLER_RETURN" ? "MFN return"
  : fallback;

function orderPayoutLines<T extends { code: string; sortOrder?: number }>(lines: T[], order: Map<string, number>) {
  return sortByPaymentFieldOrder(lines, order, (line) => normalizePaymentFieldCode(line.code));
}

function workforceDesignation(worker: any) {
  const related = Array.isArray(worker?.designations) ? worker.designations[0] : worker?.designations;
  const code = String(related?.code ?? "").trim();
  const name = String(related?.name ?? worker?.designation ?? "").trim();
  if (code && name && code.toLowerCase() !== name.toLowerCase()) return `${code} - ${name}`;
  return name || code;
}

export async function loadWorkforcePayoutRows(companyId: string, authorization: AuthorizationContext, fromDate: string, toDate: string) {
  if (!supabaseAdmin) return { rows: [] as WorkforcePayoutRow[], error: "Database connection is not configured." };
  let locationsQuery = supabaseAdmin.from("stations").select("id, station_code, station_name, location_model_id").eq("company_id", companyId);
  if (!authorization.hasAllLocationAccess) locationsQuery = locationsQuery.in("id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE]);
  const [locationsResult, allLocationsResult, mappingsResult, directAllocationsResult, allocationResult, deductionHeadsResult, paymentPolicyResult, attendanceCaptureResult] = await Promise.all([
    locationsQuery,
    readAllRows(supabaseAdmin.from("stations").select("id, station_code, station_name, location_model_id").eq("company_id", companyId)),
    readAllRows(supabaseAdmin.from("field_executive_provider_mappings").select("id, provider_member_id, station_id, provider_id, workforce_id, contractor_id, employee_id, field_executive_id, payment_method_id, payment_values, production_threshold_config, effective_from, effective_to, status, reason, providers(name,code), payment_methods(name,production_threshold_config)").eq("company_id", companyId).in("status", ["active", "closed"]).order("effective_from").order("id")),
    readAllRows(supabaseAdmin.from("workforce_payment_allocations").select("id, workforce_id, station_id, payment_method_id, payment_values, payment_components, effective_from, effective_to, status, change_reason, payment_methods:payment_methods!workforce_payment_allocations_method_company_fk(name)").eq("company_id", companyId).in("status", ["active", "closed"]).order("effective_from").order("id")),
    supabaseAdmin.from("payment_field_provider_metrics").select("payment_field_id, provider_id, provider_model_id, provider_production_metrics(source_key), payment_fields(code, label, field_type)").eq("company_id", companyId),
    supabaseAdmin.from("workforce_deduction_heads").select("id, code, name, calculation_type, default_value, percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active").eq("company_id", companyId).eq("is_active", true),
    supabaseAdmin.from("workforce_payment_settings").select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from").eq("company_id", companyId).lte("effective_from", toDate).order("effective_from"),
    supabaseAdmin.from("workforce_attendance_capture_settings").select("id,capture_method,minimum_daily_deliveries,effective_from").eq("company_id", companyId).lte("effective_from", toDate).order("effective_from")
  ]);
  const error = locationsResult.error?.message || allLocationsResult.error?.message || mappingsResult.error?.message || directAllocationsResult.error?.message || allocationResult.error?.message || deductionHeadsResult.error?.message || paymentPolicyResult.error?.message || attendanceCaptureResult.error?.message;
  if (error) return { rows: [] as WorkforcePayoutRow[], error };
  const locations = locationsResult.data ?? [];
  const allLocations = allLocationsResult.data ?? [];
  const allowed = new Set(locations.map((row) => row.id));
  const authorizedStationCodes = [...new Set(locations.map((row) => String(row.station_code ?? "").trim()).filter(Boolean))];
  const allMappings = mappingsResult.data ?? [];
  const authorizedMappings = allMappings.filter((row: any) => allowed.has(row.station_id));
  const mappings = authorizedMappings.filter((row: any) => row.payment_method_id && String(row.effective_from) <= toDate && (!row.effective_to || String(row.effective_to) >= fromDate));
  const allDirectAllocations = (directAllocationsResult.data ?? []).filter((row: any) => allowed.has(row.station_id));
  const directAllocations = allDirectAllocations.filter((row: any) => String(row.effective_from) <= toDate && (!row.effective_to || String(row.effective_to) >= fromDate));
  const directWorkforceIds = Array.from(new Set(directAllocations.map((row: any) => row.workforce_id).filter(Boolean)));
  const sourceIds = Array.from(new Set([...authorizedMappings.flatMap((row: any) => [row.workforce_id, row.contractor_id, row.employee_id, row.field_executive_id]), ...directWorkforceIds].filter(Boolean)));
  const contractorIds = Array.from(new Set(mappings.map((row: any) => row.contractor_id).filter(Boolean)));
  const employeeIds = Array.from(new Set(mappings.map((row: any) => row.employee_id).filter(Boolean)));
  const fieldExecutiveIds = Array.from(new Set(mappings.map((row: any) => row.field_executive_id).filter(Boolean)));
  const workforceIds = Array.from(new Set([...mappings.map((row: any) => row.workforce_id), ...directWorkforceIds].filter(Boolean)));
  const paymentMethodIds = Array.from(new Set([...allMappings, ...allDirectAllocations].map((row: any) => row.payment_method_id).filter(Boolean)));
  const [workforceBySourceResult, workforceByIdResult, metricsResult, modelsResult, contractorsResult, employeesResult, fieldExecutivesResult, panAadhaarResult, methodComponentsResult] = await Promise.all([
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, source_profile_type, dropx_id, full_name, designation, date_of_join, last_working_date, pan_number, onboarding_status, lifecycle_status, is_active, deleted_at, designations(code,name)").eq("company_id", companyId).in("source_profile_id", sourceIds) : Promise.resolve({ data: [], error: null }),
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, source_profile_type, dropx_id, full_name, designation, date_of_join, last_working_date, pan_number, onboarding_status, lifecycle_status, is_active, deleted_at, designations(code,name)").eq("company_id", companyId).in("id", sourceIds) : Promise.resolve({ data: [], error: null }),
    authorizedStationCodes.length ? readAllRows(supabaseAdmin.from("cps_shipment_daily").select("provider_employee_id, provider_employee_name, work_date, station_code, client, amazon_delivery, swa_delivery, total_delivery, c_return, mfn, mfn_return").eq("company_id", companyId).in("station_code", authorizedStationCodes).gte("work_date", workforcePaymentMonthStart(fromDate)).lte("work_date", toDate).order("work_date").order("station_code").order("provider_employee_id")) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("location_models").select("id, code, name").eq("company_id", companyId),
    contractorIds.length ? supabaseAdmin.from("contractors").select("id, pan_number").eq("company_id", companyId).in("id", contractorIds) : Promise.resolve({ data: [], error: null }),
    employeeIds.length ? supabaseAdmin.from("employees").select("id, pan_number").eq("company_id", companyId).in("id", employeeIds) : Promise.resolve({ data: [], error: null }),
    fieldExecutiveIds.length ? supabaseAdmin.from("workforce").select("id, pan_number").eq("company_id", companyId).in("id", fieldExecutiveIds) : Promise.resolve({ data: [], error: null }),
    workforceIds.length ? supabaseAdmin.from("connect_profile_verifications").select("account_id, verified").eq("company_id", companyId).eq("profile_type", "workforce").eq("kind", "pan_aadhaar").in("account_id", workforceIds) : Promise.resolve({ data: [], error: null }),
    paymentMethodIds.length ? readAllRows(supabaseAdmin.from("payment_method_components").select("payment_method_id,payment_field_id,component_code,component_type,label,pay_schedule,sort_order,payment_fields(id,code,label,pay_schedule,field_type,calculation_type,calculation_source,is_custom_production)").eq("company_id", companyId).eq("is_active", true).in("payment_method_id", paymentMethodIds).order("payment_method_id").order("sort_order").order("id")) : Promise.resolve({ data: [], error: null })
  ]);
  if (workforceBySourceResult.error || workforceByIdResult.error || metricsResult.error || modelsResult.error || contractorsResult.error || employeesResult.error || fieldExecutivesResult.error || panAadhaarResult.error || methodComponentsResult.error) return { rows: [] as WorkforcePayoutRow[], error: workforceBySourceResult.error?.message || workforceByIdResult.error?.message || metricsResult.error?.message || modelsResult.error?.message || contractorsResult.error?.message || employeesResult.error?.message || fieldExecutivesResult.error?.message || panAadhaarResult.error?.message || methodComponentsResult.error?.message || "Unable to load payout data." };
  const workerBySource = new Map<string, any>();
  [...(workforceBySourceResult.data ?? []), ...(workforceByIdResult.data ?? [])].forEach((row: any) => {
    if (row.id) workerBySource.set(row.id, row);
    if (row.source_profile_id) workerBySource.set(row.source_profile_id, row);
  });
  const canonicalWorkers = Array.from(new Map([
    ...directWorkforceIds,
    ...mappings.map((mapping: any) => workerBySource.get(mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id)?.id)
  ].filter(Boolean).map((id) => [id, workerBySource.get(id)])).values()).filter(Boolean);
  const thresholdHistoryStart = workforcePaymentMonthStart(fromDate);
  const payoutInputWorkforceIds = [...new Set(canonicalWorkers.map((worker: any) => String(worker.id)).filter(Boolean))];
  const payoutInputResults = await (async () => {
    const attendance: any[] = [];
    const attendancePeriods: any[] = [];
    const paymentFields: any[] = [];
    const production: any[] = [];
    for (let index = 0; index < payoutInputWorkforceIds.length; index += 100) {
      const workforceChunk = payoutInputWorkforceIds.slice(index, index + 100);
      const [attendanceResult, attendancePeriodsResult, paymentFieldResult, productionResult] = await Promise.all([
        readAllRows(supabaseAdmin!.from("workforce_payout_attendance_overrides")
          .select("id,workforce_id,station_id,work_date,attendance_status,work_minutes")
          .eq("company_id", companyId)
          .in("workforce_id", workforceChunk)
          .gte("work_date", thresholdHistoryStart)
          .lte("work_date", toDate)
          .order("work_date")
          .order("id")),
        readAllRows(supabaseAdmin!.from("workforce_payout_attendance_values")
          .select("id,workforce_id,station_id,attendance_basis,effective_from,effective_to,quantity")
          .eq("company_id", companyId)
          .in("workforce_id", workforceChunk)
          .lte("effective_from", toDate)
          .gte("effective_to", thresholdHistoryStart)
          .order("effective_from")
          .order("id")),
        readAllRows(supabaseAdmin!.from("workforce_payment_field_overrides")
          .select("id,workforce_id,station_id,payment_field_id,field_code_snapshot,effective_from,effective_to,input_value")
          .eq("company_id", companyId)
          .in("workforce_id", workforceChunk)
          .lte("effective_from", toDate)
          .gte("effective_to", thresholdHistoryStart)
          .order("effective_from")
          .order("id")),
        readAllRows(supabaseAdmin!.from("workforce_custom_production_inputs")
          .select("id,workforce_id,station_id,payment_field_id,field_code_snapshot,work_date,units")
          .eq("company_id", companyId)
          .in("workforce_id", workforceChunk)
          .gte("work_date", thresholdHistoryStart)
          .lte("work_date", toDate)
          .order("work_date")
          .order("id"))
      ]);
      const error = attendanceResult.error?.message || attendancePeriodsResult.error?.message || paymentFieldResult.error?.message || productionResult.error?.message;
      if (error) return { attendance, attendancePeriods, paymentFields, production, error };
      attendance.push(...(attendanceResult.data ?? []));
      attendancePeriods.push(...(attendancePeriodsResult.data ?? []));
      paymentFields.push(...(paymentFieldResult.data ?? []));
      production.push(...(productionResult.data ?? []));
    }
    return { attendance, attendancePeriods, paymentFields, production, error: null as string | null };
  })();
  const attendanceOverridesResult = { data: payoutInputResults.attendance, error: payoutInputResults.error ? { message: payoutInputResults.error } : null };
  const paymentFieldOverridesResult = { data: payoutInputResults.paymentFields, error: payoutInputResults.error ? { message: payoutInputResults.error } : null };
  const uploadedProductionInputsResult = { data: payoutInputResults.production, error: payoutInputResults.error ? { message: payoutInputResults.error } : null };
  const payoutInputError = attendanceOverridesResult.error?.message
    || paymentFieldOverridesResult.error?.message
    || uploadedProductionInputsResult.error?.message;
  if (payoutInputError) return { rows: [] as WorkforcePayoutRow[], error: payoutInputError };
  const payoutInputMaps = buildWorkforcePayoutInputMaps({
    attendanceOverrides: attendanceOverridesResult.data ?? [],
    attendancePeriods: payoutInputResults.attendancePeriods,
    paymentFieldOverrides: paymentFieldOverridesResult.data ?? [],
    productionInputs: uploadedProductionInputsResult.data ?? []
  });
  const thresholdMappings = mappingsForAuthorizedWorkforce(allMappings, canonicalWorkers)
    .filter((mapping: any) => mapping.payment_method_id
      && String(mapping.effective_from) <= toDate
      && (!mapping.effective_to || String(mapping.effective_to) >= thresholdHistoryStart));
  const allStationCodeById = new Map(allLocations.map((location: any) => [String(location.id), String(location.station_code ?? "").trim().toUpperCase()]));
  const hiddenThresholdStationCodes = [...new Set(thresholdMappings
    .filter((mapping: any) => !allowed.has(mapping.station_id))
    .map((mapping: any) => allStationCodeById.get(String(mapping.station_id)) ?? "")
    .filter(Boolean))];
  const hiddenThresholdMetricsResult = hiddenThresholdStationCodes.length
    ? await readAllRows(supabaseAdmin.from("cps_shipment_daily")
      .select("provider_employee_id, provider_employee_name, work_date, station_code, client, amazon_delivery, swa_delivery, total_delivery, c_return, mfn, mfn_return")
      .eq("company_id", companyId)
      .in("station_code", hiddenThresholdStationCodes)
      .gte("work_date", thresholdHistoryStart)
      .lte("work_date", toDate)
      .order("work_date")
      .order("station_code")
      .order("provider_employee_id"))
    : { data: [], error: null };
  if (hiddenThresholdMetricsResult.error) return { rows: [] as WorkforcePayoutRow[], error: hiddenThresholdMetricsResult.error.message };
  const thresholdMetricRows = [...(metricsResult.data ?? []), ...(hiddenThresholdMetricsResult.data ?? [])];
  const attendanceIdentityGroups = [
    { column: "workforce_id", ids: canonicalWorkers.map((worker: any) => worker.id) },
    { column: "employee_id", ids: canonicalWorkers.filter((worker: any) => worker.source_profile_type === "employee").map((worker: any) => worker.source_profile_id) },
    { column: "contractor_id", ids: canonicalWorkers.filter((worker: any) => worker.source_profile_type === "contractor").map((worker: any) => worker.source_profile_id) },
    { column: "field_executive_id", ids: canonicalWorkers.filter((worker: any) => worker.source_profile_type === "field_executive").map((worker: any) => worker.source_profile_id) }
  ].map((group) => ({ ...group, ids: Array.from(new Set(group.ids.filter(Boolean))) }));
  const attendanceResult = attendanceIdentityGroups.some((group) => group.ids.length) ? await (async () => {
    const rows: any[] = [];
    for (const group of attendanceIdentityGroups) {
      for (let index = 0; index < group.ids.length; index += 100) {
        const result = await readAllRows(supabaseAdmin!.from("attendance_daily")
          .select("id,workforce_id,employee_id,contractor_id,field_executive_id,punch_date,status,in_time,out_time,work_minutes")
          .eq("company_id", companyId)
          .in(group.column, group.ids.slice(index, index + 100))
          .gte("punch_date", workforcePaymentMonthStart(fromDate))
          .lte("punch_date", toDate)
          .order("punch_date")
          .order("id"));
        if (result.error) return result;
        rows.push(...(result.data ?? []));
      }
    }
    return { data: [...new Map(rows.map((row) => [row.id, row])).values()], error: null };
  })() : { data: [], error: null };
  if (attendanceResult.error) return { rows: [] as WorkforcePayoutRow[], error: attendanceResult.error.message };
  const componentsByMethod = new Map<string, DirectPayComponent[]>();
  for (const row of methodComponentsResult.data ?? []) {
    const field: any = Array.isArray(row.payment_fields) ? row.payment_fields[0] : row.payment_fields;
    const component: DirectPayComponent = {
      payment_field_id: String(field?.id ?? row.payment_field_id ?? "") || null,
      component_code: String(row.component_code ?? ""),
      component_type: String(field?.field_type ?? row.component_type ?? ""),
      label: String(field?.label ?? row.label ?? row.component_code ?? ""),
      pay_schedule: String(field?.pay_schedule ?? row.pay_schedule ?? "") || null,
      calculation_type: String(field?.calculation_type ?? "") || null,
      calculation_source: String(field?.calculation_source ?? "") || null,
      is_custom_production: field?.is_custom_production === true,
      sort_order: Number(row.sort_order)
    };
    componentsByMethod.set(String(row.payment_method_id), [...(componentsByMethod.get(String(row.payment_method_id)) ?? []), component]);
  }
  const paymentValuesForDate = (
    configuredValues: Record<string, unknown> | null | undefined,
    components: DirectPayComponent[],
    workforceId: string,
    stationId: string,
    date: string
  ) => {
    const values: Record<string, unknown> = { ...(configuredValues ?? {}) };
    for (const component of components) {
      const code = normalizePaymentFieldCode(component.component_code);
      if (!code) continue;
      const configuredEntry = Object.entries(configuredValues ?? {})
        .find(([key]) => normalizePaymentFieldCode(key) === code);
      values[code] = resolveWorkforcePaymentFieldRate(payoutInputMaps, {
        workforceId,
        stationId,
        paymentFieldId: component.payment_field_id,
        fieldCode: code,
        date,
        fallbackRate: configuredEntry?.[1]
      });
    }
    return values;
  };
  let attendanceByWorkerDate = new Map<string, any>();
  for (const row of attendanceResult.data ?? []) {
    const sourceId = row.workforce_id || row.employee_id || row.contractor_id || row.field_executive_id;
    const canonicalWorkforceId = workerBySource.get(sourceId)?.id;
    if (!canonicalWorkforceId) continue;
    const key = `${canonicalWorkforceId}|${row.punch_date}`;
    const current = attendanceByWorkerDate.get(key);
    attendanceByWorkerDate.set(key, preferredDirectPayAttendance(current, row));
  }
  const attendanceCaptureHistory = (attendanceCaptureResult.data ?? []) as WorkforceAttendanceCaptureSetting[];
  const stationCodeById = new Map(locations.map((location: any) => [String(location.id), String(location.station_code ?? "").trim().toUpperCase()]));
  const payoutMappingIdentities: WorkforcePayoutMappingIdentity[] = authorizedMappings.map((mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    const worker = workerBySource.get(sourceId);
    const provider: any = Array.isArray(mapping.providers) ? mapping.providers[0] : mapping.providers;
    return {
      id: String(mapping.id),
      providerMemberId: String(mapping.provider_member_id ?? ""),
      stationCode: stationCodeById.get(String(mapping.station_id)) ?? "",
      providerIdentity: `${provider?.code ?? ""} ${provider?.name ?? ""}`,
      effectiveFrom: String(mapping.effective_from ?? ""),
      effectiveTo: mapping.effective_to ? String(mapping.effective_to) : null,
      workforceId: String(worker?.id ?? ""),
      paymentMethodId: String(mapping.payment_method_id ?? "")
    };
  });
  const payoutMappingIdentityById = new Map(payoutMappingIdentities.map((mapping) => [mapping.id, mapping]));
  const thresholdPayoutMappingIdentities: WorkforcePayoutMappingIdentity[] = thresholdMappings.map((mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    const worker = workerBySource.get(sourceId);
    const provider: any = Array.isArray(mapping.providers) ? mapping.providers[0] : mapping.providers;
    return {
      id: String(mapping.id),
      providerMemberId: String(mapping.provider_member_id ?? ""),
      stationCode: allStationCodeById.get(String(mapping.station_id)) ?? "",
      providerIdentity: `${provider?.code ?? ""} ${provider?.name ?? ""}`,
      effectiveFrom: String(mapping.effective_from ?? ""),
      effectiveTo: mapping.effective_to ? String(mapping.effective_to) : null,
      workforceId: String(worker?.id ?? ""),
      paymentMethodId: String(mapping.payment_method_id ?? "")
    };
  });
  const thresholdPayoutMappingIdentityById = new Map(thresholdPayoutMappingIdentities.map((mapping) => [mapping.id, mapping]));
  const shipmentResolutionByRow = new Map<any, ReturnType<typeof resolveShipmentPayoutMapping>>();
  for (const row of metricsResult.data ?? []) shipmentResolutionByRow.set(row, resolveShipmentPayoutMapping(row, payoutMappingIdentities));
  const thresholdShipmentResolutionByRow = new Map<any, ReturnType<typeof resolveShipmentPayoutMapping>>();
  for (const row of thresholdMetricRows) thresholdShipmentResolutionByRow.set(row, resolveShipmentPayoutMapping(row, thresholdPayoutMappingIdentities));
  const shipmentDeliveriesByWorkerDate = aggregateShipmentDeliveriesByWorkforceDay((metricsResult.data ?? []).flatMap((row: any) => {
    const date = String(row.work_date ?? "");
    const resolution = shipmentResolutionByRow.get(row);
    return resolution?.kind === "mapped"
      ? [{ workforce_id: resolution.workforceId, work_date: date, total_delivery: Number(row.total_delivery ?? 0) }]
      : [];
  }));
  for (const worker of canonicalWorkers) {
    const cursor = new Date(`${workforcePaymentMonthStart(fromDate)}T00:00:00Z`);
    const lastDate = new Date(`${toDate}T00:00:00Z`);
    for (; cursor <= lastDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      const capture = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
      if (capture.capture_method !== "shipment_data") continue;
      const key = `${worker.id}|${date}`;
      attendanceByWorkerDate.set(key, shipmentAttendanceRecord(date, shipmentDeliveriesByWorkerDate.get(key) ?? 0, capture));
    }
  }
  attendanceByWorkerDate = new Map(overlayWorkforcePayoutAttendance(attendanceByWorkerDate, payoutInputMaps.attendanceByWorkforceDate));
  const aggregateAttendancePeriodKey = (period: { id?: string | null; workforce_id: string; station_id: string; attendance_basis: string; effective_from: string; effective_to: string }) =>
    String(period.id ?? `${period.workforce_id}|${period.station_id}|${period.attendance_basis}|${period.effective_from}|${period.effective_to}`);
  const aggregateAttendanceIssueByPeriod = new Map<string, string>();
  const aggregateAttendanceSourceByPeriod = new Map<string, string>();
  const aggregateAttendanceForDate = (workforceId: string, stationId: string, date: string, sourceKey?: string) => {
    const period = findWorkforcePayoutAttendancePeriod(payoutInputMaps, { workforceId, stationId, date });
    if (!period) return null;
    const periodKey = aggregateAttendancePeriodKey(period);
    const configuredSource = aggregateAttendanceSourceByPeriod.get(periodKey);
    if (sourceKey && configuredSource && configuredSource !== sourceKey) return null;
    const issue = aggregateAttendanceIssueByPeriod.get(periodKey) ?? null;
    return {
      period,
      issue,
      input: {
        basis: period.attendance_basis,
        // The workbook value is a total for the inclusive range. Settle it once
        // on the final day while zeroing biometric attendance pay on preceding
        // covered dates, so no quantity is invented or counted twice.
        quantity: !issue && date === period.effective_to ? period.quantity : 0
      }
    } as const;
  };
  const attendanceUnitForDate = (workforceId: string, stationId: string, date: string, sourceKey?: string) => {
    const aggregate = aggregateAttendanceForDate(workforceId, stationId, date, sourceKey);
    if (aggregate?.period.attendance_basis === "days") return aggregate.input.quantity;
    return directPayAttendanceUnit(attendanceByWorkerDate.get(`${workforceId}|${date}`));
  };
  const hasImportedAttendanceForDate = (workforceId: string, stationId: string, date: string, sourceKey?: string) =>
    Boolean(aggregateAttendanceForDate(workforceId, stationId, date, sourceKey))
    || hasWorkforcePayoutAttendanceOverride(payoutInputMaps, workforceId, date);
  const paymentPolicyHistory = (paymentPolicyResult.data ?? []) as WorkforcePaymentPolicy[];
  const dateRange = (from: string, to: string) => {
    const dates: string[] = [];
    for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= new Date(`${to}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10));
    return dates;
  };
  const panBySource = new Map([...contractorsResult.data ?? [], ...employeesResult.data ?? [], ...fieldExecutivesResult.data ?? []].map((row: any) => [row.id, row.pan_number]));
  const locationById = new Map(locations.map((row: any) => [row.id, row]));
  const allLocationById = new Map(allLocations.map((row: any) => [row.id, row]));
  const modelById = new Map((modelsResult.data ?? []).map((row: any) => [row.id, row]));
  const locationByCode = new Map(locations.map((row: any) => [normalizePayoutIdentity(row.station_code), row]));
  const allocations = allocationResult.data ?? [];
  const deductionHeads = (deductionHeadsResult.data ?? []) as AutomaticDeductionHead[];
  const panAadhaarLinkedByWorkforceId = new Map((panAadhaarResult.data ?? []).map((row: any) => [row.account_id, row.verified === true]));
  const historyByWorkforceId = new Map<string, PaymentAllocationHistoryEntry[]>();
  const historyByProviderMember = new Map<string, PaymentAllocationHistoryEntry[]>();
  const providerHistoryKey = (stationId: unknown, providerMemberId: unknown) => `${String(stationId ?? "")}|${normalizePayoutIdentity(providerMemberId)}`;
  const appendHistory = (workforceId: string, entry: PaymentAllocationHistoryEntry) => {
    if (!workforceId) return;
    historyByWorkforceId.set(workforceId, [...(historyByWorkforceId.get(workforceId) ?? []), entry]);
  };
  for (const mapping of authorizedMappings) {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    const worker = workerBySource.get(sourceId);
    const method: any = Array.isArray(mapping.payment_methods) ? mapping.payment_methods[0] : mapping.payment_methods;
    const provider: any = Array.isArray(mapping.providers) ? mapping.providers[0] : mapping.providers;
    const components = componentsByMethod.get(String(mapping.payment_method_id)) ?? [];
    const entry: PaymentAllocationHistoryEntry = {
      id: `provider-${mapping.id}`,
      paymentMethodId: String(mapping.payment_method_id ?? ""),
      paymentMethodName: String(method?.name ?? "Payment method unavailable"),
      effectiveFrom: String(mapping.effective_from ?? ""),
      effectiveTo: String(mapping.effective_to ?? ""),
      storedStatus: String(mapping.status ?? ""),
      sourceLabel: `Provider ID ${String(mapping.provider_member_id ?? "-")} · ${String(provider?.name ?? provider?.code ?? "Provider")}`,
      subjectLabel: worker ? `${String(worker.dropx_id ?? "")} · ${String(worker.full_name ?? "")}`.replace(/^ · | · $/g, "") : "",
      locationLabel: String(locationById.get(mapping.station_id)?.station_code ?? ""),
      reason: String(mapping.reason ?? ""),
      productionThreshold: parseProductionThresholdSnapshot(mapping.production_threshold_config),
      rates: paymentAllocationHistoryRates(mapping.payment_values, components.map((component) => ({ code: component.component_code, label: String(component.label ?? component.component_code), sortOrder: Number(component.sort_order ?? 0) })))
    };
    if (worker?.id) appendHistory(String(worker.id), entry);
    const memberKey = providerHistoryKey(mapping.station_id, mapping.provider_member_id);
    historyByProviderMember.set(memberKey, [...(historyByProviderMember.get(memberKey) ?? []), entry]);
  }
  for (const allocation of allDirectAllocations) {
    const worker = workerBySource.get(allocation.workforce_id);
    if (!worker?.id) continue;
    const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
    const snapshotComponents = Array.isArray(allocation.payment_components)
      ? allocation.payment_components
      : [];
    const components = snapshotComponents.length ? snapshotComponents : componentsByMethod.get(String(allocation.payment_method_id)) ?? [];
    appendHistory(String(worker.id), {
      id: `direct-${allocation.id}`,
      paymentMethodId: String(allocation.payment_method_id ?? ""),
      paymentMethodName: String(method?.name ?? "Payment method unavailable"),
      effectiveFrom: String(allocation.effective_from ?? ""),
      effectiveTo: String(allocation.effective_to ?? ""),
      storedStatus: String(allocation.status ?? ""),
      sourceLabel: "Direct workforce allocation",
      subjectLabel: `${String(worker.dropx_id ?? "")} · ${String(worker.full_name ?? "")}`.replace(/^ · | · $/g, ""),
      locationLabel: String(locationById.get(allocation.station_id)?.station_code ?? ""),
      reason: String(allocation.change_reason ?? ""),
      rates: paymentAllocationHistoryRates(allocation.payment_values, components.map((component: any) => ({ code: String(component.component_code ?? component.code ?? ""), label: String(component.label ?? component.component_code ?? component.code ?? ""), sortOrder: Number(component.sort_order ?? component.sortOrder ?? 0) })))
    });
  }
  for (const [workforceId, history] of historyByWorkforceId) historyByWorkforceId.set(workforceId, sortPaymentAllocationHistory(history));
  for (const [memberKey, history] of historyByProviderMember) historyByProviderMember.set(memberKey, sortPaymentAllocationHistory(history));
  const attendanceComponentsFor = (mapping: any) => (componentsByMethod.get(String(mapping.payment_method_id)) ?? [])
    .filter((component) => component.component_type !== "production" && component.calculation_source === "attendance_eligibility");
  const attendanceSetupSignature = (mapping: any) => JSON.stringify(attendanceComponentsFor(mapping)
    .map((component) => {
      const code = String(component.component_code ?? "").trim().toUpperCase();
      const rawRate = Object.entries(mapping.payment_values ?? {}).find(([key]) => key.trim().toUpperCase() === code)?.[1] ?? null;
      return [code, component.pay_schedule, component.calculation_type, component.calculation_source, rawRate];
    })
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  let providerAttendanceConflict = false;
  const attendanceOwnerByWorkerDate = new Map<string, string>();
  const attendanceOwnerOn = (workforceId: string, date: string) => {
    const cacheKey = `${workforceId}|${date}`;
    if (attendanceOwnerByWorkerDate.has(cacheKey)) return attendanceOwnerByWorkerDate.get(cacheKey) ?? "";
    const candidates = allMappings.filter((candidate: any) => {
      const sourceId = candidate.workforce_id || candidate.contractor_id || candidate.employee_id || candidate.field_executive_id;
      return workerBySource.get(sourceId)?.id === workforceId
        && String(candidate.effective_from) <= date
        && (!candidate.effective_to || String(candidate.effective_to) >= date)
        && attendanceComponentsFor(candidate).length > 0;
    }).sort((left: any, right: any) => String(right.effective_from).localeCompare(String(left.effective_from)) || String(right.id).localeCompare(String(left.id)));
    if (!candidates.length) {
      attendanceOwnerByWorkerDate.set(cacheKey, "");
      return "";
    }
    const latest = candidates.filter((candidate: any) => String(candidate.effective_from) === String(candidates[0].effective_from));
    if (new Set(latest.map(attendanceSetupSignature)).size > 1) providerAttendanceConflict = true;
    const ownerId = String(latest[0].id);
    attendanceOwnerByWorkerDate.set(cacheKey, ownerId);
    return ownerId;
  };
  type AggregateAttendanceSource = {
    key: string;
    values: Record<string, unknown> | null | undefined;
    components: DirectPayComponent[];
  };
  const aggregateAttendancePeriods = [...payoutInputMaps.attendancePeriodsByWorkforceStation.values()].flat();
  const mappingWorkforceId = (mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    return String(workerBySource.get(sourceId)?.id ?? "");
  };
  const directAllocationComponents = (allocation: any) => {
    const snapshot = Array.isArray(allocation.payment_components)
      ? allocation.payment_components.filter((component: unknown): component is DirectPayComponent => Boolean(component && typeof component === "object"))
      : [];
    return snapshot.length ? snapshot : componentsByMethod.get(String(allocation.payment_method_id)) ?? [];
  };
  const relevantAttendanceComponents = (components: DirectPayComponent[], basis: "hours" | "days") =>
    components.filter((component) => directPayAttendanceBasis(component) === basis);
  const aggregateAttendanceSourcesOn = (period: (typeof aggregateAttendancePeriods)[number], date: string): AggregateAttendanceSource[] => {
    const providerSources = allMappings.flatMap((mapping: any) => {
      if (mappingWorkforceId(mapping) !== period.workforce_id
        || (mapping.station_id && String(mapping.station_id) !== period.station_id)
        || !allocationActiveOn(mapping, date)) return [];
      const components = relevantAttendanceComponents(
        componentsByMethod.get(String(mapping.payment_method_id)) ?? [],
        period.attendance_basis
      );
      return components.length ? [{ key: `provider:${String(mapping.id)}`, values: mapping.payment_values, components }] : [];
    });
    const directSources = allDirectAllocations.flatMap((allocation: any) => {
      if (String(allocation.workforce_id) !== period.workforce_id
        || (allocation.station_id && String(allocation.station_id) !== period.station_id)
        || !allocationActiveOn(allocation, date)) return [];
      const components = relevantAttendanceComponents(directAllocationComponents(allocation), period.attendance_basis);
      return components.length ? [{ key: `direct:${String(allocation.id)}`, values: allocation.payment_values, components }] : [];
    });
    return [...providerSources, ...directSources];
  };
  const aggregateRateSignature = (period: (typeof aggregateAttendancePeriods)[number], source: AggregateAttendanceSource, date: string) => {
    const values = paymentValuesForDate(source.values, source.components, period.workforce_id, period.station_id, date);
    const rates = source.components.map((component) => {
      const code = normalizePaymentFieldCode(component.component_code);
      const rawRate = values[code];
      const rate = Number(rawRate);
      if (!code || rawRate == null || String(rawRate).trim() === "" || !Number.isFinite(rate) || rate < 0) return null;
      return [
        String(component.payment_field_id ?? ""),
        code,
        String(component.pay_schedule ?? ""),
        String(component.calculation_type ?? ""),
        rate
      ];
    });
    return rates.some((rate) => rate === null)
      ? null
      : JSON.stringify(rates.sort((left, right) => String(left?.[1]).localeCompare(String(right?.[1]))));
  };
  for (const period of aggregateAttendancePeriods) {
    const periodKey = aggregateAttendancePeriodKey(period);
    const overlapsVisiblePeriod = period.effective_from <= toDate && period.effective_to >= fromDate;
    const markIssue = (message: string) => {
      if (!aggregateAttendanceIssueByPeriod.has(periodKey)) aggregateAttendanceIssueByPeriod.set(periodKey, message);
    };
    if (overlapsVisiblePeriod && (period.effective_from < fromDate || period.effective_to > toDate)) {
      markIssue("Aggregate attendance cannot be prorated in a partial payout view. Open the complete uploaded attendance range.");
    }
    if (overlapsVisiblePeriod && period.effective_to > today()) {
      markIssue("Aggregate attendance is not payable until its effective range has ended.");
    }
    if (period.effective_from.slice(0, 7) !== period.effective_to.slice(0, 7)) {
      markIssue("Aggregate attendance cannot cross a calendar month. Split the upload at the month boundary.");
    }
    const sourceKeys = new Set<string>();
    const rateSignatures = new Set<string>();
    const policySignatures = new Set<string>();
    for (const date of dateRange(period.effective_from, period.effective_to)) {
      const sources = aggregateAttendanceSourcesOn(period, date);
      if (sources.length !== 1) {
        markIssue("Aggregate attendance must be covered by exactly one stable payment allocation for its entire range.");
        continue;
      }
      const source = sources[0];
      sourceKeys.add(source.key);
      const rateSignature = aggregateRateSignature(period, source, date);
      if (rateSignature === null) markIssue("Aggregate attendance has a missing or invalid payment rate.");
      else rateSignatures.add(rateSignature);
      if (period.attendance_basis === "days" && source.components.some((component) =>
        component.calculation_type === "fixed_monthly" || /month/i.test(String(component.pay_schedule ?? "")))) {
        const policy = workforcePaymentPolicyForDate(paymentPolicyHistory, date);
        policySignatures.add(JSON.stringify([
          policy.calculation_method,
          policy.paid_off_days,
          policy.work_units_per_paid_off,
          policy.cap_at_monthly_amount
        ]));
      }
    }
    if (sourceKeys.size !== 1) markIssue("The payment allocation changes inside the aggregate attendance range. Split the upload at the change date.");
    if (rateSignatures.size > 1) markIssue("A payment rate changes inside the aggregate attendance range. Split the upload at the rate change date.");
    if (policySignatures.size > 1) markIssue("The monthly attendance policy changes inside the aggregate attendance range. Split the upload at the policy change date.");
    const sourceKey = [...sourceKeys][0];
    if (sourceKeys.size === 1 && sourceKey) aggregateAttendanceSourceByPeriod.set(periodKey, sourceKey);
  }
  const sourceHasInvalidAggregateAttendance = (
    workforceId: string,
    stationId: string,
    sourceKey: string,
    payoutFrom: string,
    payoutTo: string,
    requiresMonthlyDayHistory: boolean
  ) =>
    aggregateAttendancePeriods.some((period) => period.workforce_id === workforceId
      && period.station_id === stationId
      && aggregateAttendanceIssueByPeriod.has(aggregateAttendancePeriodKey(period))
      && (!aggregateAttendanceSourceByPeriod.get(aggregateAttendancePeriodKey(period))
        || aggregateAttendanceSourceByPeriod.get(aggregateAttendancePeriodKey(period)) === sourceKey)
      && aggregateAttendanceIssueAffectsPayoutPeriod({
        attendanceBasis: period.attendance_basis,
        aggregateFrom: period.effective_from,
        aggregateTo: period.effective_to,
        payoutFrom,
        payoutTo,
        requiresMonthlyDayHistory
      }));
  type ProviderProductionRule = {
    allocationKey: string;
    paymentFieldId: string;
    code: string;
    label: string;
    componentType: "production";
    source: string | null;
    customProduction: boolean;
    rate: number;
    sortOrder?: number;
    componentOrder: number;
  };
  const productionRulesByMappingId = new Map<string, ProviderProductionRule[]>();
  const productionRulesFor = (mapping: any, location: any): ProviderProductionRule[] => {
    const mappingId = String(mapping.id);
    const cached = productionRulesByMappingId.get(mappingId);
    if (cached) return cached;
    const configuredOrder = paymentComponentOrderMap(componentsByMethod.get(String(mapping.payment_method_id)) ?? []);
    const matchingAllocations = allocations.filter((item: any) => item.provider_id === mapping.provider_id && (!item.provider_model_id || item.provider_model_id === location?.location_model_id)).flatMap((item: any) => {
      const field: any = Array.isArray(item.payment_fields) ? item.payment_fields[0] : item.payment_fields;
      const metric: any = Array.isArray(item.provider_production_metrics) ? item.provider_production_metrics[0] : item.provider_production_metrics;
      if (!field?.code || field.field_type !== "production" || !metric?.source_key) return [];
      return [{ item, field, metric }];
    });
    const allocationByCode = new Map<string, (typeof matchingAllocations)[number]>();
    for (const candidate of matchingAllocations) {
      const code = normalizePaymentFieldCode(candidate.field.code);
      const current = allocationByCode.get(code);
      // A model-specific production source overrides the provider default; it
      // must never create a second copy of the same payable component.
      if (!current || (candidate.item.provider_model_id && !current.item.provider_model_id)) allocationByCode.set(code, candidate);
    }
    const rules: ProviderProductionRule[] = [...allocationByCode.values()].map(({ item, field, metric }) => {
      const code = String(field.code);
      const rateEntry = Object.entries(mapping.payment_values ?? {}).find(([key]) => normalizePaymentFieldCode(key) === normalizePaymentFieldCode(code));
      return {
        allocationKey: `${String(item.payment_field_id ?? "")}|${String(item.provider_model_id ?? "all")}|${String(metric.source_key)}|${normalizePaymentFieldCode(code)}`,
        paymentFieldId: String(item.payment_field_id ?? ""),
        code,
        label: productionLabel(code, String(field.label || code)),
        componentType: "production" as const,
        source: String(metric.source_key),
        customProduction: false,
        rate: Number(rateEntry?.[1] ?? 0),
        sortOrder: configuredOrder.get(normalizePaymentFieldCode(code)),
        componentOrder: 0
      };
    });
    const existingCodes = new Set(rules.map((rule) => normalizePaymentFieldCode(rule.code)));
    for (const component of componentsByMethod.get(String(mapping.payment_method_id)) ?? []) {
      const code = normalizePaymentFieldCode(component.component_code);
      const paymentFieldId = String(component.payment_field_id ?? "");
      if (!code || !paymentFieldId || component.component_type !== "production" || component.is_custom_production !== true || existingCodes.has(code)) continue;
      const rateEntry = Object.entries(mapping.payment_values ?? {}).find(([key]) => normalizePaymentFieldCode(key) === code);
      rules.push({
        allocationKey: `custom|${paymentFieldId}|${code}`,
        paymentFieldId,
        code,
        label: String(component.label ?? component.component_code ?? code),
        componentType: "production",
        source: null,
        customProduction: true,
        rate: Number(rateEntry?.[1] ?? 0),
        sortOrder: configuredOrder.get(code),
        componentOrder: 0
      });
      existingCodes.add(code);
    }
    const ordered = orderPayoutLines(rules, configuredOrder).map((rule, componentOrder) => ({ ...rule, componentOrder }));
    productionRulesByMappingId.set(mappingId, ordered);
    return ordered;
  };
  const providerDailyRowsByMappingId = new Map<string, any[]>();
  const providerDailyRowsFor = (mapping: any, mappingIdentity: WorkforcePayoutMappingIdentity, workforceId: string) => {
    const mappingId = String(mapping.id);
    const cached = providerDailyRowsByMappingId.get(mappingId);
    if (cached) return cached;
    const rows = (metricsResult.data ?? []).filter((daily: any) => {
      if (!payoutMappingMatchesShipment(mappingIdentity, daily)) return false;
      const resolution = shipmentResolutionByRow.get(daily);
      return resolution?.kind === "mapped" && resolution.workforceId === workforceId;
    });
    providerDailyRowsByMappingId.set(mappingId, rows);
    return rows;
  };
  const thresholdDailyRowsByMappingId = new Map<string, any[]>();
  const thresholdDailyRowsFor = (mapping: any, mappingIdentity: WorkforcePayoutMappingIdentity, workforceId: string) => {
    const mappingId = String(mapping.id);
    const cached = thresholdDailyRowsByMappingId.get(mappingId);
    if (cached) return cached;
    const rows = thresholdMetricRows.filter((daily: any) => {
      if (!payoutMappingMatchesShipment(mappingIdentity, daily)) return false;
      const resolution = thresholdShipmentResolutionByRow.get(daily);
      return resolution?.kind === "mapped" && resolution.workforceId === workforceId;
    });
    thresholdDailyRowsByMappingId.set(mappingId, rows);
    return rows;
  };
  const productionThresholdInputId = (mappingId: unknown, date: string, rule: ProviderProductionRule) =>
    `${String(mappingId)}|${date}|${rule.allocationKey}`;
  const thresholdInputs = thresholdMappings
    .flatMap((mapping: any) => {
      const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
      const worker = workerBySource.get(sourceId);
      const location: any = allLocationById.get(mapping.station_id);
      const mappingIdentity = thresholdPayoutMappingIdentityById.get(String(mapping.id));
      if (!worker?.id || !mappingIdentity) return [];
      const activeFrom = [thresholdHistoryStart, String(mapping.effective_from), String(worker.date_of_join ?? thresholdHistoryStart)].sort().at(-1)!;
      const activeTo = [toDate, today(), String(mapping.effective_to ?? toDate), String(worker.last_working_date ?? toDate)].sort()[0];
      if (activeFrom > activeTo) return [];
      const productionRules = productionRulesFor(mapping, location);
      if (!productionRules.length) return [];
      const providerDailyRows = thresholdDailyRowsFor(mapping, mappingIdentity, String(worker.id));
      const providerDailyRowsByDate = new Map<string, any[]>();
      for (const row of providerDailyRows) {
        const date = String(row.work_date);
        providerDailyRowsByDate.set(date, [...(providerDailyRowsByDate.get(date) ?? []), row]);
      }
      const paymentMethod: any = Array.isArray(mapping.payment_methods) ? mapping.payment_methods[0] : mapping.payment_methods;
      return dateRange(activeFrom, activeTo).flatMap((date) => {
        const rows = providerDailyRowsByDate.get(date) ?? [];
        return productionRules.map((rule) => {
          const providerUnits = rule.customProduction
            ? 0
            : rows.reduce((sum: number, daily: any) => sum + metricValue(daily, String(rule.source ?? "")), 0);
          const reportedUnits = Number(resolveWorkforceCustomProductionUnits(payoutInputMaps, {
            workforceId: String(worker.id),
            stationId: String(mapping.station_id),
            paymentFieldId: rule.paymentFieldId,
            fieldCode: rule.code,
            date,
            fallbackUnits: providerUnits
          }));
          const rate = Number(resolveWorkforcePaymentFieldRate(payoutInputMaps, {
            workforceId: String(worker.id),
            stationId: String(mapping.station_id),
            paymentFieldId: rule.paymentFieldId,
            fieldCode: rule.code,
            date,
            fallbackRate: rule.rate
          }));
          return {
            id: productionThresholdInputId(mapping.id, date, rule),
            workforceId: String(worker.id),
            mappingId: String(mapping.id),
            date,
            effectiveFrom: String(mapping.effective_from),
            effectiveTo: mapping.effective_to ? String(mapping.effective_to) : null,
            componentCode: rule.code,
            componentOrder: rule.componentOrder,
            reportedUnits,
            rate,
            thresholdConfig: mapping.production_threshold_config,
            methodThresholdConfig: paymentMethod?.production_threshold_config
          };
        });
      });
    });
  const thresholdAllocationById = new Map(allocateCombinedProductionThresholds(thresholdInputs).map((allocation) => [allocation.id, allocation]));
  const providerPaymentSetupKey = (mapping: any) => JSON.stringify({
    paymentMethodId: String(mapping.payment_method_id ?? ""),
    paymentValues: Object.entries(mapping.payment_values ?? {})
      .map(([code, rate]) => [normalizePaymentFieldCode(code), Number(rate)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    productionThresholdConfig: mapping.production_threshold_config ?? null
  });
  const providerSegments = mappings.flatMap((mapping: any): ProviderPayoutSegment[] => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id; const worker = workerBySource.get(sourceId); const location: any = locationById.get(mapping.station_id); const model: any = modelById.get(location?.location_model_id); const mappingIdentity = payoutMappingIdentityById.get(String(mapping.id));
    if (!worker || !mappingIdentity) return [];
    const matchingShipmentRows = (metricsResult.data ?? []).filter((daily: any) => payoutMappingMatchesShipment(mappingIdentity, daily));
    if (matchingShipmentRows.some((daily: any) => String(daily.work_date) >= fromDate && String(daily.work_date) <= toDate && shipmentResolutionByRow.get(daily)?.kind === "conflict")) return [];
    const providerDailyRows = providerDailyRowsFor(mapping, mappingIdentity, String(worker.id));
    const providerMemberName = providerDailyRows.find((daily: any) => String(daily.provider_employee_name ?? "").trim())?.provider_employee_name ?? "-";
    const paymentMethod: any = Array.isArray(mapping.payment_methods) ? mapping.payment_methods[0] : mapping.payment_methods;
    const paymentMethodId = String(mapping.payment_method_id);
    const paymentMethodName = String(paymentMethod?.name ?? "-");
    const configuredComponentOrder = paymentComponentOrderMap(componentsByMethod.get(paymentMethodId) ?? []);
    const activeFrom = [fromDate, String(mapping.effective_from), String(worker?.date_of_join ?? fromDate)].sort().at(-1)!;
    const activeTo = [toDate, today(), String(mapping.effective_to ?? toDate), String(worker?.last_working_date ?? toDate)].sort()[0];
    const activeDates = activeFrom <= activeTo ? dateRange(activeFrom, activeTo) : [];
    const eligibleDaily = activeFrom <= activeTo ? providerDailyRows.filter((daily) => daily.work_date >= activeFrom && daily.work_date <= activeTo) : [];
    const productionRules = productionRulesFor(mapping, location);
    const attendanceComponents = attendanceComponentsFor(mapping);
    const attendanceSourceKey = `provider:${String(mapping.id)}`;
    const requiresMonthlyDayHistory = attendanceComponents.some((component) =>
      directPayAttendanceBasis(component) === "days"
      && (component.calculation_type === "fixed_monthly" || /month/i.test(String(component.pay_schedule ?? ""))));
    const invalidAggregateAttendance = activeFrom <= activeTo && sourceHasInvalidAggregateAttendance(
      String(worker.id),
      String(mapping.station_id),
      attendanceSourceKey,
      activeFrom,
      activeTo,
      requiresMonthlyDayHistory
    );
    const attendanceDates = attendanceComponents.length && worker?.id && activeFrom <= activeTo
      ? dateRange(activeFrom, activeTo).filter((date) => attendanceOwnerOn(worker.id, date) === String(mapping.id))
      : [];
    const dates = [...new Set([...activeDates, ...eligibleDaily.map((daily) => String(daily.work_date))])];
    let missingAttendanceConfiguration = false;
    let missingThresholdConfiguration = false;
    const dailyBreakdown: WorkforcePayoutRow["dailyBreakdown"] = dates.sort().reverse().map((date) => {
      const rows = eligibleDaily.filter((daily) => String(daily.work_date) === date);
      const productionLines = productionRules.map((rule) => {
        const providerUnits = rule.customProduction
          ? 0
          : rows.reduce((sum, daily) => sum + metricValue(daily, String(rule.source ?? "")), 0);
        const count = Number(resolveWorkforceCustomProductionUnits(payoutInputMaps, {
          workforceId: String(worker.id),
          stationId: String(mapping.station_id),
          paymentFieldId: rule.paymentFieldId,
          fieldCode: rule.code,
          date,
          fallbackUnits: providerUnits
        }));
        const rate = Number(resolveWorkforcePaymentFieldRate(payoutInputMaps, {
          workforceId: String(worker.id),
          stationId: String(mapping.station_id),
          paymentFieldId: rule.paymentFieldId,
          fieldCode: rule.code,
          date,
          fallbackRate: rule.rate
        }));
        const allocation = thresholdAllocationById.get(productionThresholdInputId(mapping.id, date, rule));
        if (allocation?.thresholdApplied) {
          missingThresholdConfiguration ||= allocation.thresholdConfigurationMissing;
          return {
            code: rule.code,
            label: rule.label,
            componentType: rule.componentType,
            count: allocation.payableUnits,
            reportedCount: allocation.reportedUnits,
            thresholdDeducted: allocation.thresholdDeducted,
            thresholdPeriod: allocation.thresholdPeriod,
            thresholdMinimum: allocation.thresholdMinimum,
            thresholdConfigurationMissing: allocation.thresholdConfigurationMissing,
            rate: allocation.rate,
            amount: allocation.amount,
            sortOrder: rule.sortOrder
          };
        }
        return {
          code: rule.code,
          label: rule.label,
          componentType: rule.componentType,
          count,
          rate,
          amount: count * rate,
          sortOrder: rule.sortOrder
        };
      });
      const workerDateKey = `${worker?.id}|${date}`;
      const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
      const aggregateAttendance = aggregateAttendanceForDate(String(worker.id), String(mapping.station_id), date, attendanceSourceKey);
      const ownedAttendanceComponents = attendanceDates.includes(date) || aggregateAttendance ? attendanceComponents : [];
      const hasImportedAttendance = hasImportedAttendanceForDate(String(worker.id), String(mapping.station_id), date, attendanceSourceKey);
      const attendancePay = directPayForDay(
        paymentValuesForDate(mapping.payment_values, ownedAttendanceComponents, String(worker.id), String(mapping.station_id), date),
        ownedAttendanceComponents,
        date,
        attendanceByWorkerDate.get(workerDateKey),
        {
          policyHistory: paymentPolicyHistory,
          cumulativeAttendanceUnitsBefore: cumulativeDirectPayUnitsBefore(
            date,
            [String(mapping.effective_from), String(worker?.date_of_join ?? mapping.effective_from)].sort().at(-1)!,
            (candidateDate) => {
              const sourceAggregate = aggregateAttendanceForDate(String(worker.id), String(mapping.station_id), candidateDate, attendanceSourceKey);
              return sourceAggregate || attendanceOwnerOn(String(worker.id), candidateDate) === String(mapping.id)
                ? attendanceUnitForDate(String(worker.id), String(mapping.station_id), candidateDate, attendanceSourceKey)
                : 0;
            }
          ),
          attendanceSource: hasImportedAttendance ? "biometric" : captureSetting.capture_method,
          attendanceInput: aggregateAttendance?.input
        }
      );
      const workDayUnits = attendancePay.attendanceUnit;
      missingAttendanceConfiguration ||= ownedAttendanceComponents.length > 0
        && (attendancePay.missing || Boolean(aggregateAttendance?.issue) || invalidAggregateAttendance);
      const attendanceLines = attendancePay.lines.map((line) => ({
        code: line.code,
        label: line.label,
        componentType: "amount" as const,
        count: line.count,
        rate: line.rate,
        amount: line.amount,
        sortOrder: line.sortOrder
      }));
      const lines = orderPayoutLines([...productionLines, ...attendanceLines], configuredComponentOrder);
      const baseAmount = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
      return {
        date,
        lines,
        baseAmount,
        workDayUnits,
        attendanceSource: aggregateAttendance?.period.attendance_basis === "days"
          && !aggregateAttendance.issue
          ? "Bulk upload range"
          : hasImportedAttendance ? "Bulk upload" : attendanceCaptureLabel(captureSetting.capture_method),
        attendanceRange: aggregateAttendance && date === aggregateAttendance.period.effective_to
          ? {
            basis: aggregateAttendance.period.attendance_basis,
            quantity: aggregateAttendance.period.quantity,
            effectiveFrom: aggregateAttendance.period.effective_from,
            effectiveTo: aggregateAttendance.period.effective_to
          }
          : undefined,
        methodAmounts: summarizePaymentMethodAmounts([{ methodId: paymentMethodId, label: paymentMethodName, amount: baseAmount }])
      };
    });
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = orderPayoutLines(
      summarizePayoutBreakdownLines(dailyBreakdown.flatMap((day) => day.lines)),
      configuredComponentOrder
    );
    const production = productionBreakdown.reduce((sum, line) => sum + line.count, 0);
    const baseAmount = Math.round(dailyBreakdown.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const { workDays, source: workDaysSource } = summarizeWorkDays(activeDates.map((date) => {
      const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
      const aggregateAttendance = aggregateAttendanceForDate(String(worker.id), String(mapping.station_id), date, attendanceSourceKey);
      const importedDayAttendance = hasWorkforcePayoutAttendanceOverride(payoutInputMaps, String(worker.id), date)
        || aggregateAttendance?.period.attendance_basis === "days";
      return {
        date,
        attendanceUnit: attendanceUnitForDate(String(worker.id), String(mapping.station_id), date, attendanceSourceKey),
        source: aggregateAttendance?.period.attendance_basis === "days" && !aggregateAttendance.issue
          ? "bulk_upload_range"
          : importedDayAttendance
            ? "biometric"
            : captureSetting.capture_method,
        aggregateRange: aggregateAttendance?.period.attendance_basis === "days"
          && !aggregateAttendance.issue
          && date === aggregateAttendance.period.effective_to
      };
    }));
    const paymentMethodBreakdown = summarizePaymentMethodAmounts([{ methodId: paymentMethodId, label: paymentMethodName, amount: baseAmount }]);
    const categoryCode = mapping.contractor_id ? "contractors" : mapping.employee_id ? "employees" : "workforce";
    const panAadhaarLinked = worker?.id ? panAadhaarLinkedByWorkforceId.get(worker.id) === true : false;
    const additions = 0; const grossPayment = baseAmount + additions;
    const status = missingAttendanceConfiguration || missingThresholdConfiguration ? "Configuration incomplete" : baseAmount > 0 ? "Ready for review" : attendanceDates.length ? "No eligible attendance" : "Awaiting production";
    return [{
      workforceId: String(worker.id),
      categoryCode,
      panNumber: worker?.pan_number ?? panBySource.get(sourceId) ?? null,
      paymentSetupKey: providerPaymentSetupKey(mapping),
      row: { id: mapping.id, reviewSubjectType: "workforce", reviewSubjectId: String(worker.id), dropxId: worker.dropx_id ?? "", dropxStatus: workforcePayoutDropxStatus(worker), name: worker.full_name ?? "Unlinked workforce", designation: workforceDesignation(worker), providerMemberId: mapping.provider_member_id ?? "-", providerMemberName, locationId: mapping.station_id, location: location?.station_code ?? "-", provider: mapping.providers?.name ?? "-", model: model ? `${model.code} - ${model.name}` : "All models", paymentMethod: paymentMethodName, mappingStatus: "Mapped", paymentDetailsAvailable: true, workDays, workDaysSource, history: [], paymentMethodBreakdown, production, productionBreakdown, dailyBreakdown, baseAmount, additions, grossPayment, deductions: 0, deductionBreakdown: [], panAadhaarStatus: panAadhaarLinked ? "LINKED" : "NOT LINKED", netAmount: grossPayment, status } satisfies WorkforcePayoutRow
    }];
  });
  if (providerAttendanceConflict) return { rows: [] as WorkforcePayoutRow[], error: "Conflicting provider attendance payment setups exist for the same workforce date. Resolve the duplicate rate cards before calculating payroll." };
  const consolidatedProvider = consolidateProviderPayoutSegments(providerSegments);
  if (consolidatedProvider.conflicts.length) return { rows: [] as WorkforcePayoutRow[], error: "Overlapping provider payment methods exist for the same workforce date. Correct the effective dates before calculating payroll." };
  const payoutDeductionContextByRowId = new Map<string, DeductionWorkerContext>();
  const providerRows: WorkforcePayoutRow[] = consolidatedProvider.rows.map(({ workforceId, categoryCode, panNumber, row }) => {
    const deductionContext = { categoryCode, panNumber } satisfies DeductionWorkerContext;
    const deductionBreakdown = calculateAutomaticDeductionLines(row.grossPayment, deductionHeads, deductionContext);
    const deductions = deductionBreakdown.reduce((sum, line) => sum + line.amount, 0);
    const payoutRow = {
      ...row,
      history: historyByWorkforceId.get(workforceId) ?? [],
      deductions,
      deductionBreakdown,
      netAmount: row.grossPayment - deductions
    } satisfies WorkforcePayoutRow;
    payoutDeductionContextByRowId.set(payoutRow.id, deductionContext);
    return payoutRow;
  });
  const overlappingPaymentSetup = mappings.some((mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    const canonicalWorkforceId = workerBySource.get(sourceId)?.id;
    if (!canonicalWorkforceId) return false;
    return directAllocations.some((allocation: any) => allocation.workforce_id === canonicalWorkforceId
      && String(mapping.effective_from) <= String(allocation.effective_to ?? toDate)
      && String(allocation.effective_from) <= String(mapping.effective_to ?? toDate));
  });
  if (overlappingPaymentSetup) return { rows: [] as WorkforcePayoutRow[], error: "Provider-linked and direct payment allocations overlap. Close one setup before relying on this payout estimate." };
  type ReportOnlyGroup = { kind: "unmapped" | "conflict" | "payment_missing"; workforceId: string; rows: any[] };
  const reportOnlyGroups = new Map<string, ReportOnlyGroup>();
  for (const shipment of metricsResult.data ?? []) {
    const shipmentDate = String(shipment.work_date ?? "");
    if (shipmentDate < fromDate || shipmentDate > toDate || !normalizePayoutIdentity(shipment.provider_employee_id)) continue;
    const resolution = shipmentResolutionByRow.get(shipment) ?? resolveShipmentPayoutMapping(shipment, payoutMappingIdentities);
    const kind = resolution.kind === "unmapped"
      ? "unmapped"
      : resolution.kind === "conflict"
        ? "conflict"
        : resolution.matches.some((mapping) => mapping.paymentMethodId)
          ? null
          : "payment_missing";
    if (!kind) continue;
    const groupKey = `${kind}|${shipmentIdentityKey(shipment)}|${resolution.workforceId}`;
    const group = reportOnlyGroups.get(groupKey) ?? { kind, workforceId: resolution.workforceId, rows: [] };
    group.rows.push(shipment);
    reportOnlyGroups.set(groupKey, group);
  }
  const reportOnlyRows: WorkforcePayoutRow[] = [...reportOnlyGroups.entries()].map(([groupKey, group]) => {
    const recentRows = [...group.rows].sort((left, right) => String(right.work_date ?? "").localeCompare(String(left.work_date ?? "")));
    const source = recentRows[0] ?? {};
    const namedSource = recentRows.find((row) => String(row.provider_employee_name ?? "").trim()) ?? source;
    const worker = group.kind === "payment_missing" ? workerBySource.get(group.workforceId) : null;
    const stationCode = String(source.station_code ?? "").trim();
    const location: any = locationByCode.get(normalizePayoutIdentity(stationCode));
    const providerMemberId = String(source.provider_employee_id ?? "").trim();
    const providerMemberName = String(namedSource.provider_employee_name ?? "").trim() || providerMemberId;
    const mappingStatus = group.kind === "payment_missing" ? "Mapped" : group.kind === "conflict" ? "Mapping conflict" : "ID not mapped";
    const status = group.kind === "payment_missing" ? "Payment method not allocated" : mappingStatus;
    return {
      id: `provider-report-${encodeURIComponent(groupKey)}`,
      reviewSubjectType: worker?.id ? "workforce" : undefined,
      reviewSubjectId: worker?.id ? String(worker.id) : null,
      dropxId: String(worker?.dropx_id ?? ""),
      dropxStatus: workforcePayoutDropxStatus(worker),
      name: String(worker?.full_name ?? providerMemberName),
      designation: worker ? workforceDesignation(worker) : "",
      providerMemberId,
      providerMemberName,
      locationId: location?.id ?? null,
      location: stationCode || "-",
      provider: String(source.client ?? "").trim() || "Provider report",
      model: "",
      paymentMethod: "",
      mappingStatus,
      paymentDetailsAvailable: false,
      workDays: 0,
      workDaysSource: "",
      history: worker?.id
        ? historyByWorkforceId.get(String(worker.id)) ?? []
        : historyByProviderMember.get(providerHistoryKey(location?.id, providerMemberId)) ?? [],
      paymentMethodBreakdown: [],
      production: 0,
      productionBreakdown: [],
      dailyBreakdown: [],
      baseAmount: 0,
      additions: 0,
      grossPayment: 0,
      deductions: 0,
      deductionBreakdown: [],
      panAadhaarStatus: "",
      netAmount: 0,
      status
    };
  });
  const directAllocationGroups = groupPayoutItemsBySubjectLocation(
    directAllocations,
    (allocation: any) => allocation.workforce_id,
    (allocation: any) => allocation.station_id
  );
  const directRows: WorkforcePayoutRow[] = directAllocationGroups.map(({ subjectId: workforceId, locationId, items: workerAllocations }) => {
    const worker = workerBySource.get(workforceId);
    const rawDailyBreakdown = workerAllocations.flatMap((allocation: any) => {
      const snapshotComponents = Array.isArray(allocation.payment_components)
        ? allocation.payment_components.filter((component: unknown): component is DirectPayComponent => Boolean(component && typeof component === "object"))
        : [];
      const components = snapshotComponents.length
        ? snapshotComponents
        : componentsByMethod.get(String(allocation.payment_method_id)) ?? [];
      const needsAttendanceSource = components.some((component: DirectPayComponent) => component.component_type !== "production"
        && component.calculation_source === "attendance_eligibility");
      const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
      const methodId = String(allocation.payment_method_id);
      const methodName = String(method?.name ?? "-");
      const attendanceSourceKey = `direct:${String(allocation.id)}`;
      const currentComponentOrder = paymentComponentOrderMap(componentsByMethod.get(methodId) ?? []);
      const activeFrom = [fromDate, String(allocation.effective_from), String(worker?.date_of_join ?? fromDate)].sort().at(-1)!;
      const activeTo = [toDate, today(), String(allocation.effective_to ?? toDate), String(worker?.last_working_date ?? toDate)].sort()[0];
      const requiresMonthlyDayHistory = components.some((component: DirectPayComponent) =>
        directPayAttendanceBasis(component) === "days"
        && (component.calculation_type === "fixed_monthly" || /month/i.test(String(component.pay_schedule ?? ""))));
      const invalidAggregateAttendance = activeFrom <= activeTo && sourceHasInvalidAggregateAttendance(
        workforceId,
        String(allocation.station_id),
        attendanceSourceKey,
        activeFrom,
        activeTo,
        requiresMonthlyDayHistory
      );
      return activeFrom <= activeTo ? dateRange(activeFrom, activeTo).filter((date) => allocationActiveOn(allocation, date)).map((date) => {
        const workerDateKey = `${workforceId}|${date}`;
        const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
        const aggregateAttendance = aggregateAttendanceForDate(workforceId, String(allocation.station_id), date, attendanceSourceKey);
        const hasImportedAttendance = hasImportedAttendanceForDate(workforceId, String(allocation.station_id), date, attendanceSourceKey);
        const hasImportedDayAttendance = hasWorkforcePayoutAttendanceOverride(payoutInputMaps, workforceId, date)
          || aggregateAttendance?.period.attendance_basis === "days";
        const calculation = directPayForDay(
          paymentValuesForDate(allocation.payment_values, components, workforceId, String(allocation.station_id), date),
          components,
          date,
          attendanceByWorkerDate.get(workerDateKey),
          {
            policyHistory: paymentPolicyHistory,
            cumulativeAttendanceUnitsBefore: cumulativeDirectPayUnitsBefore(
              date,
              [String(allocation.effective_from), String(worker?.date_of_join ?? allocation.effective_from)].sort().at(-1)!,
              (candidateDate) => allocationActiveOn(allocation, candidateDate)
                ? attendanceUnitForDate(workforceId, String(allocation.station_id), candidateDate, attendanceSourceKey)
                : 0
            ),
            attendanceSource: hasImportedAttendance ? "biometric" : captureSetting.capture_method,
            attendanceInput: aggregateAttendance?.input
          }
        );
        return {
          date,
          baseAmount: calculation.total,
          missing: calculation.missing
            || Boolean(aggregateAttendance?.issue)
            || invalidAggregateAttendance
            || (needsAttendanceSource && captureSetting.capture_method === "shipment_data" && !hasImportedAttendance),
          lines: orderPayoutLines(calculation.lines.map((line) => ({
            code: line.code,
            label: line.label,
            componentType: "amount" as const,
            count: line.count,
            rate: line.rate,
            amount: line.amount,
            sortOrder: line.sortOrder
          })), currentComponentOrder),
          workDayUnits: calculation.attendanceUnit,
          attendanceSource: aggregateAttendance?.period.attendance_basis === "days"
            && !aggregateAttendance.issue
            ? "Bulk upload range"
            : hasImportedAttendance ? "Bulk upload" : captureSetting.capture_method === "shipment_data" ? "Shipment data unavailable" : attendanceCaptureLabel(captureSetting.capture_method),
          captureMethod: hasImportedDayAttendance ? "biometric" : captureSetting.capture_method,
          workDaysSummarySource: aggregateAttendance?.period.attendance_basis === "days" && !aggregateAttendance.issue
            ? "bulk_upload_range" as const
            : hasImportedDayAttendance ? "biometric" as const : captureSetting.capture_method,
          aggregateWorkDays: aggregateAttendance?.period.attendance_basis === "days"
            && !aggregateAttendance.issue
            && date === aggregateAttendance.period.effective_to,
          attendanceRange: aggregateAttendance && date === aggregateAttendance.period.effective_to
            ? {
              basis: aggregateAttendance.period.attendance_basis,
              quantity: aggregateAttendance.period.quantity,
              effectiveFrom: aggregateAttendance.period.effective_from,
              effectiveTo: aggregateAttendance.period.effective_to
            }
            : undefined,
          methodAmounts: summarizePaymentMethodAmounts([{ methodId, label: methodName, amount: calculation.total }])
        };
      }) : [];
    }).sort((left, right) => right.date.localeCompare(left.date));
    const dailyByDate = new Map<string, WorkforcePayoutRow["dailyBreakdown"][number] & { missing: boolean }>();
    for (const day of rawDailyBreakdown) {
      const current = dailyByDate.get(day.date);
      dailyByDate.set(day.date, {
        date: day.date,
        baseAmount: Math.round(((current?.baseAmount ?? 0) + day.baseAmount) * 100) / 100,
        missing: Boolean(current?.missing || day.missing),
        lines: [...(current?.lines ?? []), ...day.lines],
        workDayUnits: Math.max(current?.workDayUnits ?? 0, day.workDayUnits),
        attendanceSource: current && current.attendanceSource !== day.attendanceSource ? "Mixed" : day.attendanceSource,
        attendanceRange: current?.attendanceRange ?? day.attendanceRange,
        methodAmounts: summarizePaymentMethodAmounts([...(current?.methodAmounts ?? []).map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })), ...day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount }))])
      });
    }
    const dailyBreakdown = [...dailyByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = summarizePayoutBreakdownLines(dailyBreakdown.flatMap((day) => day.lines));
    const baseAmount = Math.round(dailyBreakdown.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const workDaySummary = summarizeWorkDays(rawDailyBreakdown.map((day) => ({
      date: day.date,
      attendanceUnit: day.workDayUnits,
      source: day.workDaysSummarySource,
      aggregateRange: day.aggregateWorkDays
    })));
    const shipmentWorkDaysUnavailable = rawDailyBreakdown.some((day) => day.captureMethod === "shipment_data");
    const workDays = workDaySummary.workDays;
    const workDaysSource = shipmentWorkDaysUnavailable ? "Shipment data unavailable" : workDaySummary.source;
    const configuredMethodAmounts = workerAllocations.map((allocation: any) => {
      const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
      return { methodId: String(allocation.payment_method_id), label: String(method?.name ?? "-"), amount: 0 };
    });
    const paymentMethodBreakdown = summarizePaymentMethodAmounts([...configuredMethodAmounts, ...rawDailyBreakdown.flatMap((day) => day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })))]);
    const deductionBreakdown = calculateAutomaticDeductionLines(baseAmount, deductionHeads, { categoryCode: "workforce", panNumber: worker?.pan_number ?? null });
    const deductions = deductionBreakdown.reduce((sum, line) => sum + line.amount, 0);
    const panAadhaarLinked = panAadhaarLinkedByWorkforceId.get(workforceId) === true;
    const location: any = locationId ? locationById.get(locationId) : null;
    const methodNames = paymentMethodBreakdown.map((item) => item.label);
    const payoutRow = { id: `direct-${workforceId}-${locationId || "unassigned"}`, reviewSubjectType: "workforce", reviewSubjectId: workforceId, dropxId: worker?.dropx_id ?? "", dropxStatus: workforcePayoutDropxStatus(worker), name: worker?.full_name ?? "Unlinked workforce", designation: workforceDesignation(worker), providerMemberId: "No provider ID", providerMemberName: "Direct allocation", locationId: locationId || null, location: String(location?.station_code ?? "-"), provider: "Direct", model: "Attendance / fixed", paymentMethod: methodNames.join(" / ") || "-", mappingStatus: "Not required", paymentDetailsAvailable: true, workDays, workDaysSource, history: historyByWorkforceId.get(workforceId) ?? [], paymentMethodBreakdown, production: productionBreakdown.reduce((sum, line) => sum + line.count, 0), productionBreakdown, dailyBreakdown: dailyBreakdown.map(({ date, baseAmount, lines, workDayUnits, attendanceSource, methodAmounts, attendanceRange }) => ({ date, baseAmount, lines, workDayUnits, attendanceSource, methodAmounts, attendanceRange })), baseAmount, additions: 0, grossPayment: baseAmount, deductions, deductionBreakdown, panAadhaarStatus: panAadhaarLinked ? "LINKED" : "NOT LINKED", netAmount: baseAmount - deductions, status: shipmentWorkDaysUnavailable || dailyBreakdown.some((day) => day.missing) ? "Configuration incomplete" : baseAmount > 0 ? "Ready for review" : "No eligible accrual" } satisfies WorkforcePayoutRow;
    payoutDeductionContextByRowId.set(payoutRow.id, { categoryCode: "workforce", panNumber: worker?.pan_number ?? null });
    return payoutRow;
  });
  const additionalFieldsResult = await readAllRows(supabaseAdmin
    .from("workforce_additional_payment_fields")
    .select("id,code,name,calculation_type,default_rate_value,is_active")
    .eq("company_id", companyId)
    .order("name")
    .order("code"));
  let additionalValuesResult: { data: any[] | null; error: { message: string } | null } = { data: [], error: null };
  let deductionValuesResult: { data: any[] | null; error: { message: string } | null } = { data: [], error: null };
  if (authorization.hasAllLocationAccess || allowed.size) {
    let additionalQuery = supabaseAdmin
      .from("workforce_additional_payment_values")
      .select("id,additional_payment_field_id,workforce_id,station_id,field_code_snapshot,field_name_snapshot,calculation_type_snapshot,input_value,rate_value,final_amount")
      .eq("company_id", companyId)
      .eq("effective_from", fromDate)
      .eq("effective_to", toDate)
      .order("created_at")
      .order("id");
    let deductionQuery = supabaseAdmin
      .from("workforce_payout_deduction_values")
      .select("id,deduction_head_id,workforce_id,station_id,head_code_snapshot,head_name_snapshot,amount")
      .eq("company_id", companyId)
      .eq("effective_from", fromDate)
      .eq("effective_to", toDate)
      .order("created_at")
      .order("id");
    if (!authorization.hasAllLocationAccess) {
      additionalQuery = additionalQuery.in("station_id", [...allowed]);
      deductionQuery = deductionQuery.in("station_id", [...allowed]);
    }
    [additionalValuesResult, deductionValuesResult] = await Promise.all([
      readAllRows(additionalQuery),
      readAllRows(deductionQuery)
    ]);
  }
  if (additionalFieldsResult.error || additionalValuesResult.error || deductionValuesResult.error) {
    return {
      rows: [] as WorkforcePayoutRow[],
      error: additionalFieldsResult.error?.message
        || additionalValuesResult.error?.message
        || deductionValuesResult.error?.message
        || "Unable to load payout additions and deductions."
    };
  }
  const additionalFields = (additionalFieldsResult.data ?? []) as WorkforceAdditionalPaymentField[];
  const additionalValues = (additionalValuesResult.data ?? []) as WorkforceAdditionalPaymentValue[];
  const deductionValues = (deductionValuesResult.data ?? []) as WorkforcePayoutDeductionValue[];
  const payoutValueWorkforceIds = [...new Set([...additionalValues, ...deductionValues]
    .map((value) => String(value.workforce_id))
    .filter(Boolean))];
  const canonicalWorkerById = new Map<string, any>();
  for (const worker of workerBySource.values()) if (worker?.id) canonicalWorkerById.set(String(worker.id), worker);
  const initialRows = [...providerRows, ...reportOnlyRows, ...directRows];
  const missingPayoutValueWorkerIds = payoutValueWorkforceIds.filter((id) => !canonicalWorkerById.has(id));
  for (let index = 0; index < missingPayoutValueWorkerIds.length; index += 100) {
    const extraWorkers = await supabaseAdmin
      .from("workforce")
      .select("id,dropx_id,full_name,designation,source_profile_type,date_of_join,last_working_date,pan_number,onboarding_status,lifecycle_status,is_active,deleted_at,location_id,designations(code,name)")
      .eq("company_id", companyId)
      .in("id", missingPayoutValueWorkerIds.slice(index, index + 100));
    if (extraWorkers.error) return { rows: [] as WorkforcePayoutRow[], error: extraWorkers.error.message };
    for (const worker of extraWorkers.data ?? []) canonicalWorkerById.set(String(worker.id), worker);
  }
  const additionalGroups = groupPayoutItemsBySubjectLocation(
    additionalValues,
    (value) => value.workforce_id,
    (value) => value.station_id ?? canonicalWorkerById.get(String(value.workforce_id))?.location_id
  );
  const additionalValuesByIdentity = new Map(additionalGroups.map((group) => [
    payoutSubjectLocationKey(group.subjectId, group.locationId),
    group.items
  ]));
  const deductionGroups = groupPayoutItemsBySubjectLocation(
    deductionValues,
    (value) => value.workforce_id,
    (value) => value.station_id ?? canonicalWorkerById.get(String(value.workforce_id))?.location_id
  );
  const deductionValuesByIdentity = new Map(deductionGroups.map((group) => [
    payoutSubjectLocationKey(group.subjectId, group.locationId),
    group.items
  ]));
  const workforceDeductionContext = (workforceId: string) => {
    const worker = canonicalWorkerById.get(workforceId);
    const sourceType = String(worker?.source_profile_type ?? "");
    return {
      worker,
      categoryCode: sourceType === "contractor" ? "contractors" : sourceType === "employee" ? "employees" : "workforce",
      panNumber: worker?.pan_number ?? null
    };
  };
  const applyPayoutValues = (
    row: WorkforcePayoutRow,
    values: WorkforceAdditionalPaymentValue[],
    manualDeductions: WorkforcePayoutDeductionValue[],
    includeAutomaticDeductions = true
  ) => {
    const workforceId = String(row.reviewSubjectId ?? "");
    const additionalPaymentBreakdown = workforceAdditionalPaymentLines(row.baseAmount, additionalFields, values);
    const additions = workforceAdditionalPaymentTotal(additionalPaymentBreakdown);
    const grossPayment = Math.round((row.baseAmount + additions + Number.EPSILON) * 100) / 100;
    const context = resolveWorkforcePayoutDeductionContext(
      row.id,
      payoutDeductionContextByRowId,
      workforceDeductionContext(workforceId)
    );
    const deductionBreakdown = workforcePayoutDeductionLines(
      grossPayment,
      deductionHeads,
      { categoryCode: context.categoryCode, panNumber: context.panNumber },
      manualDeductions,
      { includeAutomaticDeductions }
    );
    const deductions = workforcePayoutDeductionTotal(deductionBreakdown);
    const hasAdditions = values.length > 0;
    const hasManualDeductions = manualDeductions.length > 0;
    const fallbackMethod = hasAdditions && hasManualDeductions
      ? "Payout adjustments"
      : hasAdditions
        ? "Additional payments only"
        : "Manual deductions only";
    const fallbackModel = hasAdditions && hasManualDeductions
      ? "Additional and deduction inputs"
      : hasAdditions
        ? "Global additional fields"
        : "Manual deduction inputs";
    return {
      ...row,
      paymentDetailsAvailable: row.paymentDetailsAvailable || hasAdditions || hasManualDeductions,
      paymentMethod: row.paymentMethod || fallbackMethod,
      model: row.model || fallbackModel,
      additionalPaymentBreakdown,
      additions,
      grossPayment,
      deductions,
      deductionBreakdown,
      netAmount: Math.round((grossPayment - deductions + Number.EPSILON) * 100) / 100,
      status: (hasAdditions || hasManualDeductions) && ["Payment method not allocated", "No eligible accrual", "No eligible attendance", "Awaiting production"].includes(row.status)
        ? "Ready for review"
        : row.status
    } satisfies WorkforcePayoutRow;
  };
  const applied = new Set<string>();
  const rowsWithPayoutValues = initialRows.map((row) => {
    const workforceId = String(row.reviewSubjectId ?? "");
    const identityKey = payoutSubjectLocationKey(workforceId, row.locationId);
    const values = additionalValuesByIdentity.get(identityKey) ?? [];
    const manualDeductions = deductionValuesByIdentity.get(identityKey) ?? [];
    if (!workforceId || (!values.length && !manualDeductions.length) || applied.has(identityKey)) return row;
    applied.add(identityKey);
    return applyPayoutValues(row, values, manualDeductions);
  });
  const payoutValueGroups = new Map([...additionalGroups, ...deductionGroups].map((group) => [
    payoutSubjectLocationKey(group.subjectId, group.locationId),
    { subjectId: group.subjectId, locationId: group.locationId }
  ]));
  for (const [identityKey, group] of payoutValueGroups) {
    const workforceId = group.subjectId;
    if (applied.has(identityKey)) continue;
    const worker = canonicalWorkerById.get(workforceId);
    if (!worker) continue;
    const locationId = group.locationId || null;
    const location: any = locationId ? locationById.get(locationId) : null;
    const values = additionalValuesByIdentity.get(identityKey) ?? [];
    const manualDeductions = deductionValuesByIdentity.get(identityKey) ?? [];
    const hasAdditions = values.length > 0;
    const hasManualDeductions = manualDeductions.length > 0;
    const inputLabel = hasAdditions && hasManualDeductions
      ? "Payout adjustments"
      : hasAdditions
        ? "Additional payment"
        : "Manual deduction";
    const blankRow: WorkforcePayoutRow = {
      id: `payout-input-${workforceId}-${group.locationId || "unassigned"}`,
      reviewSubjectType: "workforce",
      reviewSubjectId: workforceId,
      dropxId: String(worker.dropx_id ?? ""),
      dropxStatus: workforcePayoutDropxStatus(worker),
      name: String(worker.full_name ?? "Workforce"),
      designation: workforceDesignation(worker),
      providerMemberId: "No provider ID",
      providerMemberName: inputLabel,
      locationId,
      location: String(location?.station_code ?? "-"),
      provider: inputLabel,
      model: "",
      paymentMethod: "",
      mappingStatus: "Not required",
      paymentDetailsAvailable: true,
      workDays: 0,
      workDaysSource: "Not required",
      history: historyByWorkforceId.get(workforceId) ?? [],
      paymentMethodBreakdown: [],
      production: 0,
      productionBreakdown: [],
      dailyBreakdown: [],
      baseAmount: 0,
      additions: 0,
      grossPayment: 0,
      deductions: 0,
      deductionBreakdown: [],
      panAadhaarStatus: panAadhaarLinkedByWorkforceId.get(workforceId) === true ? "LINKED" : "NOT LINKED",
      netAmount: 0,
      status: "Ready for review"
    };
    const payoutValueRow = applyPayoutValues(blankRow, values, manualDeductions, hasAdditions);
    const manualDeductionAmount = manualDeductions.reduce((sum, value) => sum + Math.max(0, Number(value.amount) || 0), 0);
    if (payoutValueRow.additions > 0 || manualDeductionAmount > 0) {
      rowsWithPayoutValues.push(payoutValueRow);
      applied.add(identityKey);
    }
  }
  return { rows: rowsWithPayoutValues, error: null };
}

