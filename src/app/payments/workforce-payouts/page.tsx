import { WorkforceFinanceQueue } from "@/components/workforce-finance-queue";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { WorkforcePayoutTable, type WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { calculateAutomaticDeductionLines, type AutomaticDeductionHead } from "@/lib/workforce-deductions";
import { allocationActiveOn, directPayAttendanceUnit, directPayForDay, preferredDirectPayAttendance, type DirectPayComponent } from "@/lib/direct-workforce-pay";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { readAllRows } from "@/lib/supabase-pagination";
import { workforcePaymentMonthStart, type WorkforcePaymentPolicy } from "@/lib/workforce-payment-policy";
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  shipmentAttendanceRecord,
  workforceAttendanceCaptureSettingForDate,
  type WorkforceAttendanceCaptureSetting
} from "@/lib/workforce-attendance-capture";
import {
  attendanceCaptureLabel,
  summarizePaymentMethodAmounts,
  summarizeWorkDays
} from "@/lib/workforce-payout-summary";

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";
type ReportPeriod = { mode: "monthly" | "daily" | "range"; month: string; day: string; from: string; to: string };

function today() { return todayKolkata(); }
function currentMonth() { return today().slice(0, 7); }
function validDate(value?: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : ""; }
function validMonth(value?: string) { return /^\d{4}-\d{2}$/.test(value ?? "") ? value! : ""; }

function resolvePeriod(params: Record<string, string | string[] | undefined>): ReportPeriod & { fromDate: string; toDate: string; title: string } {
  const mode = params.period === "daily" || params.period === "range" ? params.period : "monthly";
  const month = validMonth(typeof params.month === "string" ? params.month : "") || currentMonth();
  const day = validDate(typeof params.day === "string" ? params.day : "") || today();
  const from = validDate(typeof params.from === "string" ? params.from : "") || `${month}-01`;
  const to = validDate(typeof params.to === "string" ? params.to : "") || today();
  if (mode === "daily") return { mode, month, day, from, to, fromDate: day, toDate: day, title: `Daily payout worksheet · ${day}` };
  if (mode === "range") return { mode, month, day, from, to, fromDate: from <= to ? from : to, toDate: from <= to ? to : from, title: `Payout worksheet · ${from <= to ? from : to} to ${from <= to ? to : from}` };
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  return { mode, month, day, from, to, fromDate: `${month}-01`, toDate: end.toISOString().slice(0, 10), title: `Monthly payout worksheet · ${month}` };
}
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

async function loadRows(companyId: string, authorization: AuthorizationContext, fromDate: string, toDate: string) {
  if (!supabaseAdmin) return { rows: [] as WorkforcePayoutRow[], error: "Database connection is not configured." };
  let locationsQuery = supabaseAdmin.from("stations").select("id, station_code, station_name, location_model_id").eq("company_id", companyId);
  if (!authorization.hasAllLocationAccess) locationsQuery = locationsQuery.in("id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE]);
  const [locationsResult, mappingsResult, directAllocationsResult, allocationResult, deductionHeadsResult, paymentPolicyResult, attendanceCaptureResult] = await Promise.all([
    locationsQuery,
    readAllRows(supabaseAdmin.from("field_executive_provider_mappings").select("id, provider_member_id, station_id, provider_id, workforce_id, contractor_id, employee_id, field_executive_id, payment_method_id, payment_values, effective_from, effective_to, status, providers(name,code), payment_methods(name)").eq("company_id", companyId).in("status", ["active", "closed"]).lte("effective_from", toDate).or(`effective_to.is.null,effective_to.gte.${workforcePaymentMonthStart(fromDate)}`).order("id")),
    readAllRows(supabaseAdmin.from("workforce_payment_allocations").select("id, workforce_id, station_id, payment_method_id, payment_values, payment_components, effective_from, effective_to, status, payment_methods:payment_methods!workforce_payment_allocations_method_company_fk(name)").eq("company_id", companyId).in("status", ["active", "closed"]).lte("effective_from", toDate).or(`effective_to.is.null,effective_to.gte.${fromDate}`).order("effective_from").order("id")),
    supabaseAdmin.from("payment_field_provider_metrics").select("payment_field_id, provider_id, provider_model_id, provider_production_metrics(source_key), payment_fields(code, label, field_type)").eq("company_id", companyId),
    supabaseAdmin.from("workforce_deduction_heads").select("code, name, calculation_type, default_value, percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active").eq("company_id", companyId).eq("is_active", true).eq("applies_to_all", true),
    supabaseAdmin.from("workforce_payment_settings").select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from").eq("company_id", companyId).lte("effective_from", toDate).order("effective_from"),
    supabaseAdmin.from("workforce_attendance_capture_settings").select("id,capture_method,minimum_daily_deliveries,effective_from").eq("company_id", companyId).lte("effective_from", toDate).order("effective_from")
  ]);
  const error = locationsResult.error?.message || mappingsResult.error?.message || directAllocationsResult.error?.message || allocationResult.error?.message || deductionHeadsResult.error?.message || paymentPolicyResult.error?.message || attendanceCaptureResult.error?.message;
  if (error) return { rows: [] as WorkforcePayoutRow[], error };
  const locations = locationsResult.data ?? [];
  const allowed = new Set(locations.map((row) => row.id));
  const allMappings = mappingsResult.data ?? [];
  const mappings = allMappings.filter((row: any) => allowed.has(row.station_id) && row.payment_method_id && String(row.effective_from) <= toDate && (!row.effective_to || String(row.effective_to) >= fromDate));
  const directAllocations = (directAllocationsResult.data ?? []).filter((row: any) => allowed.has(row.station_id));
  const directWorkforceIds = Array.from(new Set(directAllocations.map((row: any) => row.workforce_id).filter(Boolean)));
  const sourceIds = Array.from(new Set([...allMappings.flatMap((row: any) => [row.workforce_id, row.contractor_id, row.employee_id, row.field_executive_id]), ...directWorkforceIds].filter(Boolean)));
  const contractorIds = Array.from(new Set(mappings.map((row: any) => row.contractor_id).filter(Boolean)));
  const employeeIds = Array.from(new Set(mappings.map((row: any) => row.employee_id).filter(Boolean)));
  const fieldExecutiveIds = Array.from(new Set(mappings.map((row: any) => row.field_executive_id).filter(Boolean)));
  const providerMemberIds = Array.from(new Set(allMappings.map((row: any) => row.provider_member_id).filter(Boolean)));
  const workforceIds = Array.from(new Set([...mappings.map((row: any) => row.workforce_id), ...directWorkforceIds].filter(Boolean)));
  const paymentMethodIds = Array.from(new Set([...allMappings, ...directAllocations].map((row: any) => row.payment_method_id).filter(Boolean)));
  const [workforceBySourceResult, workforceByIdResult, metricsResult, modelsResult, contractorsResult, employeesResult, fieldExecutivesResult, panAadhaarResult, methodComponentsResult] = await Promise.all([
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, source_profile_type, dropx_id, full_name, date_of_join, last_working_date, pan_number").eq("company_id", companyId).in("source_profile_id", sourceIds) : Promise.resolve({ data: [], error: null }),
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, source_profile_type, dropx_id, full_name, date_of_join, last_working_date, pan_number").eq("company_id", companyId).in("id", sourceIds) : Promise.resolve({ data: [], error: null }),
    providerMemberIds.length ? readAllRows(supabaseAdmin.from("cps_shipment_daily").select("provider_employee_id, provider_employee_name, work_date, station_code, client, amazon_delivery, swa_delivery, total_delivery, c_return, mfn, mfn_return").eq("company_id", companyId).in("provider_employee_id", providerMemberIds).gte("work_date", workforcePaymentMonthStart(fromDate)).lte("work_date", toDate).order("work_date").order("provider_employee_id")) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("location_models").select("id, code, name").eq("company_id", companyId),
    contractorIds.length ? supabaseAdmin.from("contractors").select("id, pan_number").eq("company_id", companyId).in("id", contractorIds) : Promise.resolve({ data: [], error: null }),
    employeeIds.length ? supabaseAdmin.from("employees").select("id, pan_number").eq("company_id", companyId).in("id", employeeIds) : Promise.resolve({ data: [], error: null }),
    fieldExecutiveIds.length ? supabaseAdmin.from("workforce").select("id, pan_number").eq("company_id", companyId).in("id", fieldExecutiveIds) : Promise.resolve({ data: [], error: null }),
    workforceIds.length ? supabaseAdmin.from("connect_profile_verifications").select("account_id, verified").eq("company_id", companyId).eq("profile_type", "workforce").eq("kind", "pan_aadhaar").in("account_id", workforceIds) : Promise.resolve({ data: [], error: null }),
    paymentMethodIds.length ? readAllRows(supabaseAdmin.from("payment_method_components").select("payment_method_id,component_code,component_type,label,pay_schedule,payment_fields(label,pay_schedule,field_type,calculation_type,calculation_source)").eq("company_id", companyId).eq("is_active", true).in("payment_method_id", paymentMethodIds).order("id")) : Promise.resolve({ data: [], error: null })
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
      component_code: String(row.component_code ?? ""),
      component_type: String(field?.field_type ?? row.component_type ?? ""),
      label: String(field?.label ?? row.label ?? row.component_code ?? ""),
      pay_schedule: String(field?.pay_schedule ?? row.pay_schedule ?? "") || null,
      calculation_type: String(field?.calculation_type ?? "") || null,
      calculation_source: String(field?.calculation_source ?? "") || null
    };
    componentsByMethod.set(String(row.payment_method_id), [...(componentsByMethod.get(String(row.payment_method_id)) ?? []), component]);
  }
  const attendanceByWorkerDate = new Map<string, any>();
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
  const compactIdentity = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mappingsByProviderMember = new Map<string, any[]>();
  for (const mapping of allMappings) {
    const key = String(mapping.provider_member_id ?? "").trim().toUpperCase();
    if (key) mappingsByProviderMember.set(key, [...(mappingsByProviderMember.get(key) ?? []), mapping]);
  }
  const shipmentDeliveriesByWorkerDate = aggregateShipmentDeliveriesByWorkforceDay((metricsResult.data ?? []).flatMap((row: any) => {
    const date = String(row.work_date ?? "");
    const rowStation = String(row.station_code ?? "").trim().toUpperCase();
    const rowClient = compactIdentity(row.client);
    const candidates = (mappingsByProviderMember.get(String(row.provider_employee_id ?? "").trim().toUpperCase()) ?? []).filter((mapping: any) => {
      const provider = Array.isArray(mapping.providers) ? mapping.providers[0] : mapping.providers;
      const providerIdentity = compactIdentity(`${provider?.code ?? ""} ${provider?.name ?? ""}`);
      return String(mapping.effective_from) <= date
        && (!mapping.effective_to || String(mapping.effective_to) >= date)
        && (!mapping.station_id || stationCodeById.get(String(mapping.station_id)) === rowStation)
        && (!rowClient || providerIdentity.includes(rowClient));
    });
    const workforceForShipment = [...new Set(candidates.map((mapping: any) => {
      const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
      return workerBySource.get(sourceId)?.id;
    }).filter(Boolean))];
    return workforceForShipment.length === 1
      ? [{ workforce_id: String(workforceForShipment[0]), work_date: date, total_delivery: Number(row.total_delivery ?? 0) }]
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
  const cumulativeAttendanceUnitsBefore = new Map<string, number>();
  for (const worker of canonicalWorkers) {
    const entries = [...attendanceByWorkerDate.entries()]
      .filter(([key]) => key.startsWith(`${worker.id}|`))
      .sort(([left], [right]) => left.localeCompare(right));
    let month = "";
    let running = 0;
    for (const [key, attendance] of entries) {
      const date = key.slice(String(worker.id).length + 1);
      if (date.slice(0, 7) !== month) {
        month = date.slice(0, 7);
        running = 0;
      }
      cumulativeAttendanceUnitsBefore.set(key, running);
      running += directPayAttendanceUnit(attendance);
    }
  }
  const paymentPolicyHistory = (paymentPolicyResult.data ?? []) as WorkforcePaymentPolicy[];
  const dateRange = (from: string, to: string) => {
    const dates: string[] = [];
    for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= new Date(`${to}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10));
    return dates;
  };
  const panBySource = new Map([...contractorsResult.data ?? [], ...employeesResult.data ?? [], ...fieldExecutivesResult.data ?? []].map((row: any) => [row.id, row.pan_number]));
  const locationById = new Map(locations.map((row: any) => [row.id, row])); const modelById = new Map((modelsResult.data ?? []).map((row: any) => [row.id, row]));
  const metricsByProviderMember = new Map<string, any[]>(); (metricsResult.data ?? []).forEach((row: any) => metricsByProviderMember.set(row.provider_employee_id, [...(metricsByProviderMember.get(row.provider_employee_id) ?? []), row]));
  const allocations = allocationResult.data ?? [];
  const automaticDeductions = (deductionHeadsResult.data ?? []) as AutomaticDeductionHead[];
  const panAadhaarLinkedByWorkforceId = new Map((panAadhaarResult.data ?? []).map((row: any) => [row.account_id, row.verified === true]));
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
  const attendanceOwnerOn = (workforceId: string, date: string) => {
    const candidates = allMappings.filter((candidate: any) => {
      const sourceId = candidate.workforce_id || candidate.contractor_id || candidate.employee_id || candidate.field_executive_id;
      return workerBySource.get(sourceId)?.id === workforceId
        && String(candidate.effective_from) <= date
        && (!candidate.effective_to || String(candidate.effective_to) >= date)
        && attendanceComponentsFor(candidate).length > 0;
    }).sort((left: any, right: any) => String(right.effective_from).localeCompare(String(left.effective_from)) || String(right.id).localeCompare(String(left.id)));
    if (!candidates.length) return "";
    const latest = candidates.filter((candidate: any) => String(candidate.effective_from) === String(candidates[0].effective_from));
    if (new Set(latest.map(attendanceSetupSignature)).size > 1) providerAttendanceConflict = true;
    return String(latest[0].id);
  };
  const providerRows = mappings.map((mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id; const worker = workerBySource.get(sourceId); const location: any = locationById.get(mapping.station_id); const model: any = modelById.get(location?.location_model_id); const providerDailyRows = metricsByProviderMember.get(mapping.provider_member_id) ?? []; const providerMemberName = providerDailyRows.find((daily) => String(daily.provider_employee_name ?? "").trim())?.provider_employee_name ?? "-";
    const paymentMethod: any = Array.isArray(mapping.payment_methods) ? mapping.payment_methods[0] : mapping.payment_methods;
    const paymentMethodId = String(mapping.payment_method_id);
    const paymentMethodName = String(paymentMethod?.name ?? "-");
    const activeFrom = [fromDate, String(mapping.effective_from), String(worker?.date_of_join ?? fromDate)].sort().at(-1)!;
    const activeTo = [toDate, today(), String(mapping.effective_to ?? toDate), String(worker?.last_working_date ?? toDate)].sort()[0];
    const activeDates = activeFrom <= activeTo ? dateRange(activeFrom, activeTo) : [];
    const eligibleDaily = activeFrom <= activeTo ? providerDailyRows.filter((daily) => daily.work_date >= activeFrom && daily.work_date <= activeTo) : [];
    const productionRules = allocations.filter((item: any) => item.provider_id === mapping.provider_id && (!item.provider_model_id || item.provider_model_id === location?.location_model_id)).flatMap((item: any) => {
      const field: any = Array.isArray(item.payment_fields) ? item.payment_fields[0] : item.payment_fields; const metric: any = Array.isArray(item.provider_production_metrics) ? item.provider_production_metrics[0] : item.provider_production_metrics;
      if (!field?.code || field.field_type !== "production" || !metric?.source_key) return [];
      return [{ code: String(field.code), label: productionLabel(String(field.code), String(field.label || field.code)), source: String(metric.source_key), rate: Number(mapping.payment_values?.[field.code] ?? 0) }];
    });
    const attendanceComponents = attendanceComponentsFor(mapping);
    const attendanceDates = attendanceComponents.length && worker?.id && activeFrom <= activeTo
      ? dateRange(activeFrom, activeTo).filter((date) => attendanceOwnerOn(worker.id, date) === String(mapping.id))
      : [];
    const dates = [...new Set([...activeDates, ...eligibleDaily.map((daily) => String(daily.work_date))])];
    let missingAttendanceConfiguration = false;
    const dailyBreakdown: WorkforcePayoutRow["dailyBreakdown"] = dates.sort().reverse().map((date) => {
      const rows = eligibleDaily.filter((daily) => String(daily.work_date) === date);
      const productionLines = productionRules.map((rule) => { const count = rows.reduce((sum, daily) => sum + metricValue(daily, rule.source), 0); return { code: rule.code, label: rule.label, count, rate: rule.rate, amount: count * rule.rate }; });
      const ownedAttendanceComponents = attendanceDates.includes(date) ? attendanceComponents : [];
      const workerDateKey = `${worker?.id}|${date}`;
      const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
      const workDayUnits = directPayAttendanceUnit(attendanceByWorkerDate.get(workerDateKey));
      const attendancePay = directPayForDay(
        mapping.payment_values,
        ownedAttendanceComponents,
        date,
        attendanceByWorkerDate.get(workerDateKey),
        {
          policyHistory: paymentPolicyHistory,
          cumulativeAttendanceUnitsBefore: cumulativeAttendanceUnitsBefore.get(workerDateKey) ?? 0,
          attendanceSource: captureSetting.capture_method
        }
      );
      missingAttendanceConfiguration ||= ownedAttendanceComponents.length > 0 && attendancePay.missing;
      const attendanceLines = attendancePay.lines.map((line) => ({ code: line.code, label: line.label, count: line.count, rate: line.rate, amount: line.amount }));
      const lines = [...productionLines, ...attendanceLines];
      const baseAmount = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
      return {
        date,
        lines,
        baseAmount,
        workDayUnits,
        attendanceSource: attendanceCaptureLabel(captureSetting.capture_method),
        methodAmounts: summarizePaymentMethodAmounts([{ methodId: paymentMethodId, label: paymentMethodName, amount: baseAmount }])
      };
    });
    const lineMap = new Map<string, { code: string; label: string; count: number; rate: number; amount: number }>();
    for (const day of dailyBreakdown) for (const line of day.lines) {
      const current = lineMap.get(line.code) ?? { ...line, count: 0, amount: 0 };
      current.count += line.count; current.amount += line.amount; lineMap.set(line.code, current);
    }
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = [...lineMap.values()].map((line) => ({ ...line, count: Math.round(line.count * 100) / 100, amount: Math.round(line.amount * 100) / 100 }));
    const production = productionBreakdown.reduce((sum, line) => sum + line.count, 0);
    const baseAmount = Math.round(dailyBreakdown.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const { workDays, source: workDaysSource } = summarizeWorkDays(activeDates.map((date) => {
      const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
      return {
        date,
        attendanceUnit: directPayAttendanceUnit(attendanceByWorkerDate.get(`${worker?.id}|${date}`)),
        source: captureSetting.capture_method
      };
    }));
    const paymentMethodBreakdown = summarizePaymentMethodAmounts([{ methodId: paymentMethodId, label: paymentMethodName, amount: baseAmount }]);
    const categoryCode = mapping.contractor_id ? "contractors" : mapping.employee_id ? "employees" : "workforce";
    const deductionBreakdown = calculateAutomaticDeductionLines(baseAmount, automaticDeductions, { categoryCode, panNumber: panBySource.get(sourceId) }); const deductions = deductionBreakdown.reduce((sum, line) => sum + line.amount, 0); const panAadhaarLinked = worker?.id ? panAadhaarLinkedByWorkforceId.get(worker.id) === true : false;
    const additions = 0; const grossPayment = baseAmount + additions;
    const status = missingAttendanceConfiguration ? "Configuration incomplete" : baseAmount > 0 ? "Ready for review" : attendanceDates.length ? "No eligible attendance" : "Awaiting production";
    return { id: mapping.id, dropxId: worker?.dropx_id ?? "-", name: worker?.full_name ?? "Unlinked workforce", providerMemberId: mapping.provider_member_id ?? "-", providerMemberName, locationId: mapping.station_id, location: location?.station_code ?? "-", provider: mapping.providers?.name ?? "-", model: model ? `${model.code} - ${model.name}` : "All models", paymentMethod: paymentMethodName, workDays, workDaysSource, paymentMethodBreakdown, production, productionBreakdown, dailyBreakdown, baseAmount, additions, grossPayment, deductions, deductionBreakdown, panAadhaarStatus: panAadhaarLinked ? "LINKED" : "NOT LINKED", netAmount: grossPayment - deductions, status } satisfies WorkforcePayoutRow;
  });
  if (providerAttendanceConflict) return { rows: [] as WorkforcePayoutRow[], error: "Conflicting provider attendance payment setups exist for the same workforce date. Resolve the duplicate rate cards before calculating payroll." };
  const overlappingPaymentSetup = mappings.some((mapping: any) => {
    const sourceId = mapping.workforce_id || mapping.contractor_id || mapping.employee_id || mapping.field_executive_id;
    const canonicalWorkforceId = workerBySource.get(sourceId)?.id;
    if (!canonicalWorkforceId) return false;
    return directAllocations.some((allocation: any) => allocation.workforce_id === canonicalWorkforceId
      && String(mapping.effective_from) <= String(allocation.effective_to ?? toDate)
      && String(allocation.effective_from) <= String(mapping.effective_to ?? toDate));
  });
  if (overlappingPaymentSetup) return { rows: [] as WorkforcePayoutRow[], error: "Provider-linked and direct payment allocations overlap. Close one setup before relying on this payout estimate." };
  const allocationsByWorkforce = new Map<string, any[]>();
  for (const allocation of directAllocations) allocationsByWorkforce.set(String(allocation.workforce_id), [
    ...(allocationsByWorkforce.get(String(allocation.workforce_id)) ?? []),
    allocation
  ]);
  const directRows: WorkforcePayoutRow[] = [...allocationsByWorkforce.entries()].map(([workforceId, workerAllocations]) => {
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
      const activeFrom = [fromDate, String(allocation.effective_from), String(worker?.date_of_join ?? fromDate)].sort().at(-1)!;
      const activeTo = [toDate, today(), String(allocation.effective_to ?? toDate), String(worker?.last_working_date ?? toDate)].sort()[0];
      return activeFrom <= activeTo ? dateRange(activeFrom, activeTo).filter((date) => allocationActiveOn(allocation, date)).map((date) => {
        const workerDateKey = `${workforceId}|${date}`;
        const captureSetting = workforceAttendanceCaptureSettingForDate(attendanceCaptureHistory, date);
        const calculation = directPayForDay(
          allocation.payment_values,
          components,
          date,
          attendanceByWorkerDate.get(workerDateKey),
          {
            policyHistory: paymentPolicyHistory,
            cumulativeAttendanceUnitsBefore: cumulativeAttendanceUnitsBefore.get(workerDateKey) ?? 0,
            attendanceSource: captureSetting.capture_method
          }
        );
        return {
          date,
          baseAmount: calculation.total,
          missing: calculation.missing || (needsAttendanceSource && captureSetting.capture_method === "shipment_data"),
          lines: calculation.lines.map((line) => ({ code: line.code, label: line.label, count: line.count, rate: line.rate, amount: line.amount })),
          workDayUnits: calculation.attendanceUnit,
          attendanceSource: captureSetting.capture_method === "shipment_data" ? "Shipment data unavailable" : attendanceCaptureLabel(captureSetting.capture_method),
          captureMethod: captureSetting.capture_method,
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
        methodAmounts: summarizePaymentMethodAmounts([...(current?.methodAmounts ?? []).map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })), ...day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount }))])
      });
    }
    const dailyBreakdown = [...dailyByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
    const lineMap = new Map<string, { code: string; label: string; count: number; rate: number; amount: number }>();
    for (const day of dailyBreakdown) for (const line of day.lines) {
      const current = lineMap.get(line.code) ?? { ...line, count: 0, amount: 0 };
      current.count += line.count;
      current.amount += line.amount;
      lineMap.set(line.code, current);
    }
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = [...lineMap.values()].map((line) => ({
      ...line,
      count: Math.round(line.count * 100) / 100,
      rate: line.count ? Math.round(line.amount / line.count * 100) / 100 : line.rate,
      amount: Math.round(line.amount * 100) / 100
    }));
    const baseAmount = Math.round(dailyBreakdown.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const workDaySummary = summarizeWorkDays(rawDailyBreakdown.map((day) => ({ date: day.date, attendanceUnit: day.workDayUnits, source: day.captureMethod })));
    const shipmentWorkDaysUnavailable = rawDailyBreakdown.some((day) => day.captureMethod === "shipment_data");
    const workDays = workDaySummary.workDays;
    const workDaysSource = shipmentWorkDaysUnavailable ? "Shipment data unavailable" : workDaySummary.source;
    const configuredMethodAmounts = workerAllocations.map((allocation: any) => {
      const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
      return { methodId: String(allocation.payment_method_id), label: String(method?.name ?? "-"), amount: 0 };
    });
    const paymentMethodBreakdown = summarizePaymentMethodAmounts([...configuredMethodAmounts, ...rawDailyBreakdown.flatMap((day) => day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })))]);
    const deductionBreakdown = calculateAutomaticDeductionLines(baseAmount, automaticDeductions, { categoryCode: "workforce", panNumber: worker?.pan_number ?? null });
    const deductions = deductionBreakdown.reduce((sum, line) => sum + line.amount, 0);
    const panAadhaarLinked = panAadhaarLinkedByWorkforceId.get(workforceId) === true;
    const locationIds = [...new Set(workerAllocations.map((allocation: any) => String(allocation.station_id ?? "")).filter(Boolean))];
    const locationLabels = [...new Set(locationIds.map((id) => locationById.get(id)?.station_code ?? "-"))];
    const methodNames = paymentMethodBreakdown.map((item) => item.label);
    return { id: `direct-${workforceId}`, dropxId: worker?.dropx_id ?? "-", name: worker?.full_name ?? "Unlinked workforce", providerMemberId: "No provider ID", providerMemberName: "Direct allocation", locationId: locationIds[0] ?? null, location: locationLabels.join(" / ") || "-", provider: "Direct", model: "Attendance / fixed", paymentMethod: methodNames.join(" / ") || "-", workDays, workDaysSource, paymentMethodBreakdown, production: productionBreakdown.reduce((sum, line) => sum + line.count, 0), productionBreakdown, dailyBreakdown: dailyBreakdown.map(({ date, baseAmount, lines, workDayUnits, attendanceSource, methodAmounts }) => ({ date, baseAmount, lines, workDayUnits, attendanceSource, methodAmounts })), baseAmount, additions: 0, grossPayment: baseAmount, deductions, deductionBreakdown, panAadhaarStatus: panAadhaarLinked ? "LINKED" : "NOT LINKED", netAmount: baseAmount - deductions, status: shipmentWorkDaysUnavailable || dailyBreakdown.some((day) => day.missing) ? "Configuration incomplete" : baseAmount > 0 ? "Ready for review" : "No eligible accrual" };
  });
  const rows = [...providerRows, ...directRows];
  return { rows, error: null };
}

export const dynamic = "force-dynamic";
export default async function WorkforcePayoutsPage({ searchParams = {} }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const period = resolvePeriod(searchParams);
  const authorization = await requirePagePermission("workforce_payouts", "access"); const companyId = requireCompanyId(authorization); const { rows, error } = await loadRows(companyId, authorization, period.fromDate, period.toDate);
  const gross = rows.reduce((sum, row) => sum + row.baseAmount, 0); const ready = rows.filter((row) => row.baseAmount > 0).length;
  return <AppShell active="Workforce Payouts" pageCode="workforce_payouts"><PageHead eyebrow="Payments" title="Workforce Payouts" subtitle="Calculate provider production and attendance-based workforce earnings, then review additions and deductions before payout." action={<PendingLink className="button secondary" href="/master/payment-methods?deductions=1">Deduction Heads</PendingLink>} />
    <WorkforceFinanceQueue companyId={companyId} authorization={authorization} status={typeof searchParams.payrollStatus === "string" ? searchParams.payrollStatus : undefined}/>
    <h2>Live estimate worksheet · not a payment instruction</h2>
    {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load payouts</strong><p className="subtle">{error}</p></div></section> : <><div className="stat-grid four"><div className="stat-card"><span>Payment allocations</span><strong>{rows.length}</strong></div><div className="stat-card"><span>Payment rows</span><strong>{ready}</strong></div><div className="stat-card"><span>Gross amount</span><strong>Rs {gross.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div><div className="stat-card"><span>Pending review</span><strong>{ready}</strong></div></div><section className="panel"><div className="panel-head payout-period-head"><div><h2>{period.title}</h2><p className="subtle">Only workforce in your allocated locations is shown. Provider production and attendance-based amounts use effective dates and recorded attendance.</p></div><form className="payout-period-filter" method="get"><label>Period<select className="field" name="period" defaultValue={period.mode}><option value="monthly">Monthly</option><option value="daily">Daily</option><option value="range">Custom range</option></select></label><label>Month<input className="field" type="month" name="month" defaultValue={period.month} /></label><label>Day<input className="field" type="date" name="day" defaultValue={period.day} /></label><label>From<input className="field" type="date" name="from" defaultValue={period.from} /></label><label>To<input className="field" type="date" name="to" defaultValue={period.to} /></label><button className="button secondary" type="submit">Apply</button></form></div><WorkforcePayoutTable rows={rows} /></section></>}
  </AppShell>;
}
