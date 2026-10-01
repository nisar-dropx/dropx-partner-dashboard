import type { AuthorizationContext } from "@/lib/authorization";
import {
  allocationActiveOn,
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
import { calculateAutomaticDeductionLines, type AutomaticDeductionHead } from "@/lib/workforce-deductions";
import { workforcePaymentMonthStart, type WorkforcePaymentPolicy } from "@/lib/workforce-payment-policy";
import { summarizePaymentMethodAmounts, summarizeWorkDays } from "@/lib/workforce-payout-summary";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";

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
      .select("id,helper_id,station_id,payment_method_id,payment_values,payment_components,effective_from,effective_to,status,payment_methods:payment_methods!helper_payment_allocations_method_company_fk(name)")
      .eq("company_id", companyId)
      .in("status", ["active", "closed"])
      .lte("effective_from", toDate)
      .or(`effective_to.is.null,effective_to.gte.${fromDate}`)
      .order("effective_from")
      .order("id")),
    supabaseAdmin
      .from("workforce_deduction_heads")
      .select("code,name,calculation_type,default_value,percentage_without_pan,workforce_category_codes,applies_to_all,is_system,is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("applies_to_all", true),
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
  const allocations = (allocationsResult.data ?? []).filter((allocation: any) => allowedLocationIds.has(String(allocation.station_id)));
  const allocatedHelperIds = [...new Set(allocations.map((allocation: any) => String(allocation.helper_id)).filter(Boolean))];
  const helperIds = helperPayoutPopulationIds(currentHelpers, allocations);
  const paymentMethodIds = [...new Set(allocations.map((allocation: any) => String(allocation.payment_method_id)).filter(Boolean))];

  const attendanceFromDate = workforcePaymentMonthStart(fromDate);
  const [helpersResult, verificationResult, componentsResult, helperEnrolmentsResult] = await Promise.all([
    helperIds.length
      ? readAllRows(supabaseAdmin
        .from("helpers")
        .select("id,dropx_id,full_name,date_of_join,pan_number,biometric_id,location_id,designation")
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
        .select("payment_method_id,component_code,component_type,label,pay_schedule,payment_fields(label,pay_schedule,field_type,calculation_type,calculation_source)")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("payment_method_id", paymentMethodIds)
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
      : Promise.resolve({ data: [], error: null })
  ]);

  const relatedError = helpersResult.error?.message
    || verificationResult.error?.message
    || componentsResult.error?.message
    || helperEnrolmentsResult.error?.message;
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
      calculation_source: String(field?.calculation_source ?? "") || null
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

  const cumulativeAttendanceUnitsBefore = new Map<string, number>();
  for (const helper of helpers) {
    const helperId = String(helper.id);
    const entries = [...attendanceByHelperDate.entries()]
      .filter(([key]) => key.startsWith(`${helperId}|`))
      .sort(([left], [right]) => left.localeCompare(right));
    let month = "";
    let running = 0;
    for (const [key, attendance] of entries) {
      const date = key.slice(helperId.length + 1);
      if (date.slice(0, 7) !== month) {
        month = date.slice(0, 7);
        running = 0;
      }
      cumulativeAttendanceUnitsBefore.set(key, running);
      running += directPayAttendanceUnit(attendance);
    }
  }

  const paymentPolicyHistory = (paymentPolicyResult.data ?? []) as WorkforcePaymentPolicy[];
  const automaticDeductions = (deductionHeadsResult.data ?? []) as AutomaticDeductionHead[];
  const verificationByHelperId = new Map((verificationResult.data ?? []).map((row: any) => [String(row.account_id), row.verified === true]));
  const locationById = new Map(locations.map((location: any) => [String(location.id), location]));
  const allocationsByHelper = new Map<string, any[]>();
  for (const allocation of allocations) {
    if (!helperById.has(String(allocation.helper_id))) continue;
    allocationsByHelper.set(String(allocation.helper_id), [
      ...(allocationsByHelper.get(String(allocation.helper_id)) ?? []),
      allocation
    ]);
  }

  const rows: WorkforcePayoutRow[] = helpers.map((helper: any) => {
    const helperId = String(helper.id);
    const helperAllocations = allocationsByHelper.get(helperId) ?? [];
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
      const activeFrom = [helperPeriodFrom, String(allocation.effective_from)].sort().at(-1)!;
      const activeTo = [helperPeriodTo, String(allocation.effective_to ?? helperPeriodTo)].sort()[0];

      return activeFrom <= activeTo
        ? dateRange(activeFrom, activeTo).filter((date) => allocationActiveOn(allocation, date)).map((date) => {
          const helperDateKey = `${helperId}|${date}`;
          const hasBiometricEnrolment = (helperEnrolmentsByHelper.get(helperId) ?? [])
            .some((enrolment) => enrolmentActiveOn(enrolment, date));
          const calculation = directPayForDay(
            allocation.payment_values,
            components,
            date,
            attendanceByHelperDate.get(helperDateKey),
            {
              policyHistory: paymentPolicyHistory,
              cumulativeAttendanceUnitsBefore: cumulativeAttendanceUnitsBefore.get(helperDateKey) ?? 0,
              attendanceSource: "biometric"
            }
          );
          return {
            date,
            baseAmount: calculation.total,
            missing: calculation.missing || (needsAttendanceSource && !hasBiometricEnrolment),
            lines: calculation.lines.map((line) => ({ code: line.code, label: line.label, componentType: "amount" as const, count: line.count, rate: line.rate, amount: line.amount })),
            workDayUnits: calculation.attendanceUnit,
            attendanceSource: hasBiometricEnrolment ? "Biometric" : "Biometric enrolment unavailable",
            captureMethod: "biometric" as const,
            methodAmounts: summarizePaymentMethodAmounts([{ methodId, label: methodName, amount: calculation.total }])
          };
        })
        : [];
    }).sort((left, right) => right.date.localeCompare(left.date));

    const dailyByDate = new Map<string, WorkforcePayoutRow["dailyBreakdown"][number] & { missing: boolean; captureMethod: "biometric" | "shipment_data" }>();
    for (const day of rawDailyBreakdown) {
      const current = dailyByDate.get(day.date);
      dailyByDate.set(day.date, {
        date: day.date,
        baseAmount: Math.round(((current?.baseAmount ?? 0) + day.baseAmount) * 100) / 100,
        missing: Boolean(current?.missing || day.missing),
        lines: [...(current?.lines ?? []), ...day.lines],
        workDayUnits: Math.max(current?.workDayUnits ?? 0, day.workDayUnits),
        attendanceSource: current && current.attendanceSource !== day.attendanceSource ? "Mixed" : day.attendanceSource,
        captureMethod: current && current.captureMethod !== day.captureMethod ? "shipment_data" : day.captureMethod,
        methodAmounts: summarizePaymentMethodAmounts([
          ...(current?.methodAmounts ?? []).map((item) => ({ methodId: item.id, label: item.label, amount: item.amount })),
          ...day.methodAmounts.map((item) => ({ methodId: item.id, label: item.label, amount: item.amount }))
        ])
      });
    }

    const dailyBreakdownWithState = [...dailyByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
    const lineMap = new Map<string, WorkforcePayoutRow["productionBreakdown"][number]>();
    for (const day of dailyBreakdownWithState) for (const line of day.lines) {
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
    const baseAmount = Math.round(dailyBreakdownWithState.reduce((sum, day) => sum + day.baseAmount, 0) * 100) / 100;
    const workDaySummary = summarizeWorkDays(rawDailyBreakdown.map((day) => ({
      date: day.date,
      attendanceUnit: day.workDayUnits,
      source: day.captureMethod
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
    const deductionBreakdown = helperAllocations.length
      ? calculateAutomaticDeductionLines(baseAmount, automaticDeductions, {
        categoryCode: "workers",
        panNumber: helper?.pan_number ?? null
      })
      : [];
    const deductions = deductionBreakdown.reduce((sum, line) => sum + line.amount, 0);
    const locationIds = [...new Set((helperAllocations.length
      ? helperAllocations.map((allocation: any) => String(allocation.station_id ?? ""))
      : [String(helper?.location_id ?? "")]).filter(Boolean))];
    const locationLabels = [...new Set(locationIds.map((id) => locationById.get(id)?.station_code ?? "-"))];
    const dailyBreakdown = dailyBreakdownWithState.map(({ date, baseAmount: dailyBaseAmount, lines, workDayUnits, attendanceSource, methodAmounts }) => ({
      date,
      baseAmount: dailyBaseAmount,
      lines,
      workDayUnits,
      attendanceSource,
      methodAmounts
    }));

    return {
      id: `helper-${helperId}`,
      dropxId: helper?.dropx_id ?? "-",
      name: helper?.full_name ?? "Unlinked Helper",
      providerMemberId: "No provider ID",
      providerMemberName: "Helper direct pay",
      locationId: locationIds[0] ?? null,
      location: locationLabels.join(" / ") || "-",
      provider: "Direct",
      model: helperAllocations.length ? "Attendance / fixed" : "No payment method",
      paymentMethod: paymentMethodBreakdown.map((item) => item.label).join(" / ") || "Not allocated",
      workDays: workDaySummary.workDays,
      workDaysSource: !helperAllocations.length
        ? "Unavailable until payment allocation"
        : biometricConfigurationMissing
          ? "Biometric enrolment unavailable"
          : workDaySummary.source,
      paymentMethodBreakdown,
      production: productionBreakdown.reduce((sum, line) => sum + line.count, 0),
      productionBreakdown,
      dailyBreakdown,
      baseAmount,
      additions: 0,
      grossPayment: baseAmount,
      deductions,
      deductionBreakdown,
      panAadhaarStatus: verificationByHelperId.get(helperId) === true ? "LINKED" : "NOT LINKED",
      netAmount: baseAmount - deductions,
      status: !helperAllocations.length
        ? "Payment method not allocated"
        : biometricConfigurationMissing || dailyBreakdownWithState.some((day) => day.missing)
          ? "Configuration incomplete"
          : baseAmount > 0
            ? "Ready for review"
            : "No eligible accrual"
    } satisfies WorkforcePayoutRow;
  });

  return { rows, error: null };
}
