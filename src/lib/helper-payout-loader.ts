import type { AuthorizationContext } from "@/lib/authorization";
import {
  allocationActiveOn,
  cumulativeDirectPayUnitsBefore,
  directPayAttendanceUnit,
  directPayForDay,
  preferredDirectPayAttendance,
  type DirectPayComponent
} from "@/lib/direct-workforce-pay";
import {
  biometricIdBelongsOnlyToProfile,
  helperBiometricIdVariants,
  helperPayoutPopulationIds,
  normalizeHelperBiometricId
} from "@/lib/helper-payout";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import type { AutomaticDeductionHead } from "@/lib/workforce-deductions";
import { workforcePaymentMonthStart, type WorkforcePaymentPolicy } from "@/lib/workforce-payment-policy";
import { summarizePaymentMethodAmounts, summarizePayoutBreakdownLines, summarizeWorkDays } from "@/lib/workforce-payout-summary";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { workforcePayoutDropxStatus } from "@/lib/workforce-payout-population";
import { normalizePaymentFieldCode, paymentComponentOrderMap, sortByPaymentFieldOrder } from "@/lib/payment-field-order";
import { paymentAllocationHistoryRates, sortPaymentAllocationHistory, type PaymentAllocationHistoryEntry } from "@/lib/payment-allocation-history";
import { groupPayoutItemsBySubjectLocation } from "@/lib/workforce-payout-location-groups";
import {
  calculateHelperPayoutAdjustments,
  helperPayoutAttendanceInputForDate,
  helperPayoutAttendancePeriodForDate,
  type HelperAdditionalPaymentValue,
  type HelperPayoutAttendanceValue,
  type HelperPayoutDeductionValue
} from "@/lib/helper-payout-input-overlays";
import type { WorkforceAdditionalPaymentField } from "@/lib/workforce-additional-payment-overlay";

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";

function dateRange(from: string, to: string) {
  const dates: string[] = [];
  for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= new Date(`${to}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

export async function loadHelperPayoutRows(
  companyId: string,
  authorization: AuthorizationContext,
  fromDate: string,
  toDate: string
) {
  if (!supabaseAdmin) return { rows: [] as WorkforcePayoutRow[], error: "Database connection is not configured." };

  let locationsQuery = supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, is_active")
    .eq("company_id", companyId);
  if (!authorization.hasAllLocationAccess) {
    locationsQuery = locationsQuery.in("id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE]);
  }

  const [locationsResult, currentHelpersResult, allocationsResult, deductionHeadsResult, paymentPolicyResult] = await Promise.all([
    locationsQuery,
    readAllRows(supabaseAdmin
      .from("helpers")
      .select("id,location_id,date_of_join")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("onboarding_status", "active")
      .or(`date_of_join.is.null,date_of_join.lte.${toDate}`)
      .order("id")),
    readAllRows(supabaseAdmin
      .from("helper_payment_allocations")
      .select("id,helper_id,station_id,payment_method_id,payment_values,payment_components,effective_from,effective_to,status,change_reason,payment_methods:payment_methods!helper_payment_allocations_method_company_fk(name)")
      .eq("company_id", companyId)
      .in("status", ["active", "closed"])
      .order("effective_from")
      .order("id")),
    supabaseAdmin
      .from("workforce_deduction_heads")
      .select("id,code,name,calculation_type,default_value,percentage_without_pan,workforce_category_codes,applies_to_all,is_system,is_active")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("workforce_payment_settings")
      .select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from")
      .eq("company_id", companyId)
      .lte("effective_from", toDate)
      .order("effective_from")
  ]);

  const initialError = locationsResult.error?.message
    || currentHelpersResult.error?.message
    || allocationsResult.error?.message
    || deductionHeadsResult.error?.message
    || paymentPolicyResult.error?.message;
  if (initialError) return { rows: [] as WorkforcePayoutRow[], error: initialError };

  const locations = locationsResult.data ?? [];
  const allowedLocationIds = new Set(locations.map((location) => String(location.id)));
  const activeLocationIds = new Set(locations
    .filter((location) => location.is_active === true)
    .map((location) => String(location.id)));
  const currentHelpers = (currentHelpersResult.data ?? []).filter((helper: any) => activeLocationIds.has(String(helper.location_id)));
  const allAllocations = (allocationsResult.data ?? []).filter((allocation: any) => allowedLocationIds.has(String(allocation.station_id)));
  const allocations = allAllocations.filter((allocation: any) => String(allocation.effective_from) <= toDate && (!allocation.effective_to || String(allocation.effective_to) >= fromDate));
  const allocatedHelperIds = [...new Set(allocations.map((allocation: any) => String(allocation.helper_id)).filter(Boolean))];
  const helperIds = helperPayoutPopulationIds(currentHelpers, allocations);
  const paymentMethodIds = [...new Set(allAllocations.map((allocation: any) => String(allocation.payment_method_id)).filter(Boolean))];

  const attendanceFromDate = workforcePaymentMonthStart(fromDate);
  const [
    helpersResult,
    verificationResult,
    componentsResult,
    helperEnrolmentsResult,
    attendanceValuesResult,
    additionalFieldsResult,
    additionalValuesResult,
    deductionValuesResult
  ] = await Promise.all([
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("helpers")
        .select("id,dropx_id,full_name,date_of_join,pan_number,biometric_id,location_id,designation,onboarding_status,is_active")
        .eq("company_id", companyId)
        .in("id", helperIds)
        .order("dropx_id")
        .order("id"))
      : Promise.resolve({ data: [], error: null }),
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("connect_profile_verifications")
        .select("account_id,verified")
        .eq("company_id", companyId)
        .eq("profile_type", "worker")
        .eq("kind", "pan_aadhaar")
        .in("account_id", helperIds))
      : Promise.resolve({ data: [], error: null }),
    paymentMethodIds.length
      ? readAllRows(supabaseAdmin
        .from("payment_method_components")
        .select("payment_method_id,component_code,component_type,label,pay_schedule,sort_order,payment_fields(label,pay_schedule,field_type,calculation_type,calculation_source)")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("payment_method_id", paymentMethodIds)
        .order("payment_method_id")
        .order("sort_order")
        .order("id"))
      : Promise.resolve({ data: [], error: null }),
    allocatedHelperIds.length
      ? readAllRows(supabaseAdmin
        .from("biometric_enrolments")
        .select("id,enrolment_id,profile_type,account_id,effective_from,effective_to")
        .eq("company_id", companyId)
        .eq("profile_type", "worker")
        .in("account_id", allocatedHelperIds)
        .lte("effective_from", toDate)
        .or(`effective_to.is.null,effective_to.gte.${attendanceFromDate}`)
        .order("effective_from")
        .order("id"))
      : Promise.resolve({ data: [], error: null }),
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("helper_payout_attendance_values")
        .select("id,helper_id,station_id,attendance_basis,effective_from,effective_to,quantity")
        .eq("company_id", companyId)
        .in("helper_id", helperIds)
        .lte("effective_from", toDate)
        .gte("effective_to", attendanceFromDate)
        .order("effective_from")
        .order("id"))
      : Promise.resolve({ data: [], error: null }),
    readAllRows(supabaseAdmin
      .from("workforce_additional_payment_fields")
      .select("id,code,name,calculation_type,default_rate_value,is_active")
      .eq("company_id", companyId)
      .order("name")
      .order("code")),
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("helper_additional_payment_values")
        .select("id,additional_payment_field_id,helper_id,station_id,field_code_snapshot,field_name_snapshot,calculation_type_snapshot,input_value,rate_value,final_amount")
        .eq("company_id", companyId)
        .in("helper_id", helperIds)
        .eq("effective_from", fromDate)
        .eq("effective_to", toDate)
        .order("created_at")
        .order("id"))
      : Promise.resolve({ data: [], error: null }),
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("helper_payout_deduction_values")
        .select("id,deduction_head_id,helper_id,station_id,head_code_snapshot,head_name_snapshot,amount")
        .eq("company_id", companyId)
        .in("helper_id", helperIds)
        .eq("effective_from", fromDate)
        .eq("effective_to", toDate)
        .order("created_at")
        .order("id"))
      : Promise.resolve({ data: [], error: null })
  ]);

  const relatedError = helpersResult.error?.message
    || verificationResult.error?.message
    || componentsResult.error?.message
    || helperEnrolmentsResult.error?.message
    || attendanceValuesResult.error?.message
    || additionalFieldsResult.error?.message
    || additionalValuesResult.error?.message
    || deductionValuesResult.error?.message;
  if (relatedError) return { rows: [] as WorkforcePayoutRow[], error: relatedError };

  const helpers = helpersResult.data ?? [];
  const helperById = new Map(helpers.map((helper: any) => [String(helper.id), helper]));
  const helperEnrolments = helperEnrolmentsResult.data ?? [];
  const biometricVariants = helperBiometricIdVariants(helperEnrolments.map((enrolment: any) => enrolment.enrolment_id));
  const allEnrolments: any[] = [];
  for (let index = 0; index < biometricVariants.length; index += 100) {
    const ownerResult = await readAllRows(supabaseAdmin
      .from("biometric_enrolments")
      .select("id,enrolment_id,profile_type,account_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .in("enrolment_id", biometricVariants.slice(index, index + 100))
      .lte("effective_from", toDate)
      .or(`effective_to.is.null,effective_to.gte.${attendanceFromDate}`)
      .order("effective_from")
      .order("id"));
    if (ownerResult.error) return { rows: [] as WorkforcePayoutRow[], error: ownerResult.error.message };
    allEnrolments.push(...(ownerResult.data ?? []));
  }

  const attendanceRows: any[] = [];
  for (let index = 0; index < biometricVariants.length; index += 100) {
    const attendanceResult = await readAllRows(supabaseAdmin
      .from("attendance_daily")
      .select("id,enrolment_id,punch_date,status,in_time,out_time,work_minutes,worker_type,workforce_id,employee_id,contractor_id,field_executive_id")
      .eq("company_id", companyId)
      .in("enrolment_id", biometricVariants.slice(index, index + 100))
      .gte("punch_date", attendanceFromDate)
      .lte("punch_date", toDate)
      .order("punch_date")
      .order("id"));
    if (attendanceResult.error) return { rows: [] as WorkforcePayoutRow[], error: attendanceResult.error.message };
    attendanceRows.push(...(attendanceResult.data ?? []));
  }

  const componentsByMethod = new Map<string, DirectPayComponent[]>();
  for (const row of componentsResult.data ?? []) {
    const field: any = Array.isArray(row.payment_fields) ? row.payment_fields[0] : row.payment_fields;
    const component: DirectPayComponent = {
      component_code: String(row.component_code ?? ""),
      component_type: String(field?.field_type ?? row.component_type ?? ""),
      label: String(field?.label ?? row.label ?? row.component_code ?? ""),
      pay_schedule: String(field?.pay_schedule ?? row.pay_schedule ?? "") || null,
      calculation_type: String(field?.calculation_type ?? "") || null,
      calculation_source: String(field?.calculation_source ?? "") || null,
      sort_order: Number(row.sort_order)
    };
    componentsByMethod.set(String(row.payment_method_id), [
      ...(componentsByMethod.get(String(row.payment_method_id)) ?? []),
      component
    ]);
  }

  const attendanceByHelperDate = new Map<string, any>();
  const enrolmentActiveOn = (enrolment: any, date: string) => String(enrolment.effective_from) <= date
    && (!enrolment.effective_to || String(enrolment.effective_to) >= date);
  const helperEnrolmentsByKey = new Map<string, any[]>();
  const allEnrolmentsByKey = new Map<string, any[]>();
  const helperEnrolmentsByHelper = new Map<string, any[]>();
  for (const enrolment of helperEnrolments) {
    const key = normalizeHelperBiometricId(enrolment.enrolment_id);
    helperEnrolmentsByKey.set(key, [...(helperEnrolmentsByKey.get(key) ?? []), enrolment]);
    helperEnrolmentsByHelper.set(String(enrolment.account_id), [...(helperEnrolmentsByHelper.get(String(enrolment.account_id)) ?? []), enrolment]);
  }
  for (const enrolment of allEnrolments) {
    const key = normalizeHelperBiometricId(enrolment.enrolment_id);
    allEnrolmentsByKey.set(key, [...(allEnrolmentsByKey.get(key) ?? []), enrolment]);
  }
  for (const row of new Map(attendanceRows.map((attendance) => [String(attendance.id), attendance])).values()) {
    const biometricKey = normalizeHelperBiometricId(row.enrolment_id);
    const date = String(row.punch_date);
    const helperOwners = [...new Set((helperEnrolmentsByKey.get(biometricKey) ?? [])
      .filter((enrolment) => enrolmentActiveOn(enrolment, date))
      .map((enrolment) => String(enrolment.account_id))
      .filter(Boolean))];
    if (!helperOwners.length) continue;
    const allOwners = [...new Set((allEnrolmentsByKey.get(biometricKey) ?? [])
      .filter((enrolment) => enrolmentActiveOn(enrolment, date))
      .map((enrolment) => `${String(enrolment.profile_type ?? "unknown")}|${String(enrolment.account_id ?? enrolment.id)}`))];
    const helperId = helperOwners.length === 1 ? helperOwners[0] : "";
    const rowOwnedByAnotherProfile = String(row.worker_type ?? "individual_contract") !== "individual_contract"
      || Boolean(row.workforce_id || row.employee_id || row.contractor_id || row.field_executive_id);
    const uniqueHelperOwner = biometricIdBelongsOnlyToProfile(helperId, "worker", allOwners.map((owner) => {
      const separator = owner.indexOf("|");
      return { source: owner.slice(0, separator), id: owner.slice(separator + 1) };
    }));
    if (!helperId || !uniqueHelperOwner || rowOwnedByAnotherProfile) {
      return {
        rows: [] as WorkforcePayoutRow[],
        error: `Biometric ID ${String(row.enrolment_id)} is not uniquely owned by one Helper on ${date}. Resolve the enrolment conflict before calculating Helper pay.`
      };
    }
    const key = `${helperId}|${date}`;
    attendanceByHelperDate.set(key, preferredDirectPayAttendance(attendanceByHelperDate.get(key), row));
  }

  const paymentPolicyHistory = (paymentPolicyResult.data ?? []) as WorkforcePaymentPolicy[];
  const automaticDeductions = (deductionHeadsResult.data ?? []) as AutomaticDeductionHead[];
  const attendanceValues = (attendanceValuesResult.data ?? [])
    .filter((value: any) => allowedLocationIds.has(String(value.station_id))) as HelperPayoutAttendanceValue[];
  const additionalFields = (additionalFieldsResult.data ?? []) as WorkforceAdditionalPaymentField[];
  const additionalValues = (additionalValuesResult.data ?? [])
    .filter((value: any) => allowedLocationIds.has(String(value.station_id))) as HelperAdditionalPaymentValue[];
  const deductionValues = (deductionValuesResult.data ?? [])
    .filter((value: any) => allowedLocationIds.has(String(value.station_id))) as HelperPayoutDeductionValue[];
  const inputIdentity = (helperId: unknown, stationId: unknown) => `${String(helperId ?? "")}|${String(stationId ?? "")}`;
  const additionalValuesByIdentity = new Map<string, HelperAdditionalPaymentValue[]>();
  const deductionValuesByIdentity = new Map<string, HelperPayoutDeductionValue[]>();
  for (const value of additionalValues) {
    const key = inputIdentity(value.helper_id, value.station_id);
    additionalValuesByIdentity.set(key, [...(additionalValuesByIdentity.get(key) ?? []), value]);
  }
  for (const value of deductionValues) {
    const key = inputIdentity(value.helper_id, value.station_id);
    deductionValuesByIdentity.set(key, [...(deductionValuesByIdentity.get(key) ?? []), value]);
  }
  const verificationByHelperId = new Map((verificationResult.data ?? []).map((row: any) => [String(row.account_id), row.verified === true]));
  const locationById = new Map(locations.map((location: any) => [String(location.id), location]));
  const historyByHelperId = new Map<string, PaymentAllocationHistoryEntry[]>();
  for (const allocation of allAllocations) {
    const helperId = String(allocation.helper_id ?? "");
    const helper = helperById.get(helperId);
    if (!helperId || !helper) continue;
    const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
    const snapshotComponents = Array.isArray(allocation.payment_components) ? allocation.payment_components : [];
    const components = snapshotComponents.length ? snapshotComponents : componentsByMethod.get(String(allocation.payment_method_id)) ?? [];
    const entry: PaymentAllocationHistoryEntry = {
      id: `helper-${allocation.id}`,
      paymentMethodId: String(allocation.payment_method_id ?? ""),
      paymentMethodName: String(method?.name ?? "Payment method unavailable"),
      effectiveFrom: String(allocation.effective_from ?? ""),
      effectiveTo: String(allocation.effective_to ?? ""),
      storedStatus: String(allocation.status ?? ""),
      sourceLabel: "Helper direct pay",
      subjectLabel: `${String(helper.dropx_id ?? "")} · ${String(helper.full_name ?? "")}`.replace(/^ · | · $/g, ""),
      locationLabel: String(locationById.get(String(allocation.station_id))?.station_code ?? ""),
      reason: String(allocation.change_reason ?? ""),
      rates: paymentAllocationHistoryRates(allocation.payment_values, components.map((component: any) => ({ code: String(component.component_code ?? component.code ?? ""), label: String(component.label ?? component.component_code ?? component.code ?? ""), sortOrder: Number(component.sort_order ?? component.sortOrder ?? 0) })))
    };
    historyByHelperId.set(helperId, [...(historyByHelperId.get(helperId) ?? []), entry]);
  }
  for (const [helperId, history] of historyByHelperId) historyByHelperId.set(helperId, sortPaymentAllocationHistory(history));
  const helperGroups = groupPayoutItemsBySubjectLocation(
    allocations.filter((allocation: any) => helperById.has(String(allocation.helper_id))),
    (allocation: any) => allocation.helper_id,
    (allocation: any) => allocation.station_id
  );
  const groupedHelperIds = new Set(helperGroups.map((group) => group.subjectId));
  for (const helper of helpers) {
    const helperId = String(helper.id);
    if (!groupedHelperIds.has(helperId)) {
      helperGroups.push({ subjectId: helperId, locationId: String(helper.location_id ?? ""), items: [] });
    }
  }

  const rows: WorkforcePayoutRow[] = helperGroups.map(({ subjectId: helperId, locationId, items: helperAllocations }) => {
    const helper: any = helperById.get(helperId);
    const helperPeriodFrom = [fromDate, String(helper?.date_of_join ?? fromDate)].sort().at(-1)!;
    const helperPeriodTo = [toDate, todayKolkata()].sort()[0];
    const rawDailyBreakdown = helperAllocations.flatMap((allocation: any) => {
      const snapshotComponents = Array.isArray(allocation.payment_components)
        ? allocation.payment_components.filter((component: unknown): component is DirectPayComponent => Boolean(component && typeof component === "object"))
        : [];
      const components: DirectPayComponent[] = snapshotComponents.length
        ? snapshotComponents
        : componentsByMethod.get(String(allocation.payment_method_id)) ?? [];
      const needsAttendanceSource = components.some((component) => component.component_type !== "production"
        && component.calculation_source === "attendance_eligibility");
      const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
      const methodId = String(allocation.payment_method_id);
      const methodName = String(method?.name ?? "-");
      const currentComponentOrder = paymentComponentOrderMap(componentsByMethod.get(methodId) ?? []);
      const activeFrom = [helperPeriodFrom, String(allocation.effective_from)].sort().at(-1)!;
      const activeTo = [helperPeriodTo, String(allocation.effective_to ?? helperPeriodTo)].sort()[0];

      return activeFrom <= activeTo
        ? dateRange(activeFrom, activeTo).filter((date) => allocationActiveOn(allocation, date)).map((date) => {
          const helperDateKey = `${helperId}|${date}`;
          const aggregateAttendancePeriod = helperPayoutAttendancePeriodForDate(attendanceValues, {
            helperId,
            stationId: String(allocation.station_id),
            date
          });
          const aggregateAttendanceInput = helperPayoutAttendanceInputForDate(aggregateAttendancePeriod, date);
          const hasBiometricEnrolment = (helperEnrolmentsByHelper.get(helperId) ?? [])
            .some((enrolment) => enrolmentActiveOn(enrolment, date));
          const calculation = directPayForDay(
            allocation.payment_values,
            components,
            date,
            attendanceByHelperDate.get(helperDateKey),
            {
              policyHistory: paymentPolicyHistory,
              cumulativeAttendanceUnitsBefore: cumulativeDirectPayUnitsBefore(
                date,
                [String(allocation.effective_from), String(helper?.date_of_join ?? allocation.effective_from)].sort().at(-1)!,
                (candidateDate) => {
                  if (!allocationActiveOn(allocation, candidateDate)) return 0;
                  const candidatePeriod = helperPayoutAttendancePeriodForDate(attendanceValues, {
                    helperId,
                    stationId: String(allocation.station_id),
                    date: candidateDate
                  });
                  const candidateInput = helperPayoutAttendanceInputForDate(candidatePeriod, candidateDate);
                  return candidateInput?.basis === "days"
                    ? candidateInput.quantity
                    : directPayAttendanceUnit(attendanceByHelperDate.get(`${helperId}|${candidateDate}`));
                }
              ),
              attendanceSource: "biometric",
              attendanceInput: aggregateAttendanceInput
            }
          );
          return {
            date,
            baseAmount: calculation.total,
            missing: calculation.missing || (needsAttendanceSource && !hasBiometricEnrolment && !aggregateAttendancePeriod),
            lines: sortByPaymentFieldOrder(
              calculation.lines.map((line) => ({ code: line.code, label: line.label, componentType: "amount" as const, count: line.count, rate: line.rate, amount: line.amount, sortOrder: line.sortOrder })),
              currentComponentOrder,
              (line) => normalizePaymentFieldCode(line.code)
            ),
            workDayUnits: calculation.attendanceUnit,
            attendanceSource: aggregateAttendancePeriod ? "Bulk upload range" : hasBiometricEnrolment ? "Biometric" : "Biometric enrolment unavailable",
            captureMethod: "biometric" as const,
            workDaysSummarySource: aggregateAttendancePeriod?.attendance_basis === "days" ? "bulk_upload_range" as const : "biometric" as const,
            aggregateWorkDays: aggregateAttendancePeriod?.attendance_basis === "days" && date === aggregateAttendancePeriod.effective_to,
            attendanceRange: aggregateAttendancePeriod && date === aggregateAttendancePeriod.effective_to ? {
              basis: aggregateAttendancePeriod.attendance_basis as "hours" | "days",
              quantity: Number(aggregateAttendancePeriod.quantity),
              effectiveFrom: aggregateAttendancePeriod.effective_from,
              effectiveTo: aggregateAttendancePeriod.effective_to
            } : undefined,
            methodAmounts: summarizePaymentMethodAmounts([{ methodId, label: methodName, amount: calculation.total }])
          };
        })
        : [];
    }).sort((left, right) => right.date.localeCompare(left.date));

    const dailyByDate = new Map<string, (typeof rawDailyBreakdown)[number]>();
    for (const day of rawDailyBreakdown) {
      const current = dailyByDate.get(day.date);
      dailyByDate.set(day.date, {
        date: day.date,
        baseAmount: Math.round(((current?.baseAmount ?? 0) + day.baseAmount) * 100) / 100,
        missing: Boolean(current?.missing || day.missing),
        lines: [...(current?.lines ?? []), ...day.lines],
        workDayUnits: Math.max(current?.workDayUnits ?? 0, day.workDayUnits),
        attendanceSource: current && current.attendanceSource !== day.attendanceSource ? "Mixed" : day.attendanceSource,
        captureMethod: day.captureMethod,
        workDaysSummarySource: current?.workDaysSummarySource ?? day.workDaysSummarySource,
        aggregateWorkDays: Boolean(current?.aggregateWorkDays || day.aggregateWorkDays),
        attendanceRange: current?.attendanceRange ?? day.attendanceRange,
        methodAmounts: summarizePaymentMethodAmounts([
          ...(current?.methodAmounts ?? []).map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })),
          ...day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount }))
        ])
      });
    }

    const dailyBreakdownWithState = [...dailyByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = summarizePayoutBreakdownLines(dailyBreakdownWithState.flatMap((day) => day.lines));
    const baseAmount = Math.round(dailyBreakdownWithState.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const workDaySummary = summarizeWorkDays(rawDailyBreakdown.map((day) => ({
      date: day.date,
      attendanceUnit: day.workDayUnits,
      source: day.workDaysSummarySource,
      aggregateRange: day.aggregateWorkDays
    })));
    const biometricConfigurationMissing = rawDailyBreakdown.some((day) => day.attendanceSource.includes("unavailable"));
    const configuredMethodAmounts = helperAllocations.map((allocation: any) => {
      const method: any = Array.isArray(allocation.payment_methods) ? allocation.payment_methods[0] : allocation.payment_methods;
      return { methodId: String(allocation.payment_method_id), label: String(method?.name ?? "-"), amount: 0 };
    });
    const paymentMethodBreakdown = summarizePaymentMethodAmounts([
      ...configuredMethodAmounts,
      ...rawDailyBreakdown.flatMap((day) => day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })))
    ]);
    const resolvedLocationId = locationId || String(helper?.location_id ?? "");
    const location: any = resolvedLocationId ? locationById.get(resolvedLocationId) : null;
    const adjustmentIdentity = inputIdentity(helperId, resolvedLocationId);
    const helperAdditionalValues = additionalValuesByIdentity.get(adjustmentIdentity) ?? [];
    const helperDeductionValues = deductionValuesByIdentity.get(adjustmentIdentity) ?? [];
    const hasAdjustments = helperAdditionalValues.length > 0 || helperDeductionValues.length > 0;
    const adjustments = calculateHelperPayoutAdjustments({
      baseAmount,
      additionalFields,
      additionalValues: helperAdditionalValues,
      deductionHeads: automaticDeductions,
      deductionValues: helperDeductionValues,
      deductionContext: { categoryCode: "workers", panNumber: helper?.pan_number ?? null },
      includeAutomaticDeductions: helperAllocations.length > 0 || helperAdditionalValues.length > 0
    });
    const dailyBreakdown = dailyBreakdownWithState.map(({ date, baseAmount: dailyBaseAmount, lines, workDayUnits, attendanceSource, methodAmounts, attendanceRange }) => ({
      date,
      baseAmount: dailyBaseAmount,
      lines,
      workDayUnits,
      attendanceSource,
      methodAmounts,
      attendanceRange
    }));

    return {
      id: `helper-${helperId}-${resolvedLocationId || "unassigned"}`,
      reviewSubjectType: "helper",
      reviewSubjectId: helperId,
      dropxId: helper?.dropx_id ?? "-",
      dropxStatus: workforcePayoutDropxStatus(helper),
      name: helper?.full_name ?? "Unlinked Helper",
      designation: String(helper?.designation ?? "").trim(),
      providerMemberId: "No provider ID",
      providerMemberName: "Helper direct pay",
      locationId: resolvedLocationId || null,
      location: String(location?.station_code ?? "-"),
      provider: "Direct",
      model: helperAllocations.length ? "Attendance / fixed" : hasAdjustments ? "Payout adjustments" : "No payment method",
      paymentMethod: paymentMethodBreakdown.map((item) => item.label).join(" / ")
        || (helperAdditionalValues.length && helperDeductionValues.length
          ? "Payout adjustments"
          : helperAdditionalValues.length ? "Additional payments only"
            : helperDeductionValues.length ? "Manual deductions only" : "Not allocated"),
      mappingStatus: "Not required",
      paymentDetailsAvailable: true,
      workDays: workDaySummary.workDays,
      workDaysSource: !helperAllocations.length
        ? "Unavailable until payment allocation"
        : biometricConfigurationMissing
          ? "Biometric enrolment unavailable"
          : workDaySummary.source,
      history: historyByHelperId.get(helperId) ?? [],
      paymentMethodBreakdown,
      production: productionBreakdown.reduce((sum, line) => sum + line.count, 0),
      productionBreakdown,
      dailyBreakdown,
      baseAmount,
      additionalPaymentBreakdown: adjustments.additionalPaymentBreakdown,
      additions: adjustments.additions,
      grossPayment: adjustments.grossPayment,
      deductions: adjustments.deductions,
      deductionBreakdown: adjustments.deductionBreakdown,
      panAadhaarStatus: verificationByHelperId.get(helperId) === true ? "LINKED" : "NOT LINKED",
      netAmount: adjustments.netAmount,
      status: !helperAllocations.length && !hasAdjustments
        ? "Payment method not allocated"
        : biometricConfigurationMissing || dailyBreakdownWithState.some((day) => day.missing)
          ? "Configuration incomplete"
          : adjustments.grossPayment > 0 || helperDeductionValues.length > 0
            ? "Ready for review"
            : "No eligible accrual"
    } satisfies WorkforcePayoutRow;
  });

  return { rows, error: null };
}
