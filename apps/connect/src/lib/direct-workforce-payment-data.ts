import "server-only";

import type { ConnectAccount } from "@/lib/connect-auth";
import { isMissingColumnError } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  calculateDirectWorkforcePayments,
  type DirectAttendanceDay,
  type DirectPaymentAllocation,
  type DirectPaymentMethod
} from "@/lib/direct-workforce-payment";
import {
  workforcePaymentMonthStart,
  type WorkforcePaymentPolicy
} from "../../../../src/lib/workforce-payment-policy.ts";
import {
  workforceAttendanceCaptureSettingForDate,
  type WorkforceAttendanceCaptureSetting
} from "../../../../src/lib/workforce-attendance-capture.ts";

export type CanonicalPaymentWorker = {
  id: string;
  designation_id: string | null;
  location_id: string | null;
  date_of_join: string | null;
  last_working_date: string | null;
  source_profile_id: string | null;
  source_profile_type: string | null;
};

export function attendanceIdentityFilter(worker: Pick<CanonicalPaymentWorker, "id" | "source_profile_id" | "source_profile_type">) {
  const sourceColumn = worker.source_profile_type === "employee" ? "employee_id"
    : worker.source_profile_type === "contractor" ? "contractor_id"
      : worker.source_profile_type === "field_executive" ? "field_executive_id"
        : "";
  return [
    `workforce_id.eq.${worker.id}`,
    sourceColumn && worker.source_profile_id ? `and(workforce_id.is.null,${sourceColumn}.eq.${worker.source_profile_id})` : ""
  ].filter(Boolean).join(",");
}

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

export async function resolveCanonicalPaymentWorker(account: ConnectAccount): Promise<CanonicalPaymentWorker | null> {
  let query = db().from("workforce")
    .select("id,designation_id,location_id,date_of_join,last_working_date,source_profile_id,source_profile_type")
    .eq("company_id", account.companyId)
    .is("deleted_at", null)
    .neq("migration_state", "reclassified");
  query = account.profileType === "workforce"
    ? query.eq("id", account.id)
    : query.eq("source_profile_type", account.profileType).eq("source_profile_id", account.id);
  const result = await query.maybeSingle();
  if (result.error) throw new Error("Your Workforce identity could not be verified.");
  return result.data as CanonicalPaymentWorker | null;
}

async function directAllocationRows(companyId: string, workforceId: string, from: string, to: string) {
  const result = await db().from("workforce_payment_allocations")
    .select("id,workforce_id,station_id,station_code_snapshot,designation_id,designation_code_snapshot,designation_name_snapshot,payment_method_id,payment_values,payment_components,effective_from,effective_to,status")
    .eq("company_id", companyId)
    .eq("workforce_id", workforceId)
    .neq("status", "cancelled")
    .lte("effective_from", to)
    .or(`effective_to.is.null,effective_to.gte.${from}`)
    .order("effective_from", { ascending: false })
    .limit(1000);
  if (result.error) {
    // Keep existing provider-linked users working during a staged database rollout.
    if (isMissingColumnError(result.error)) return [] as DirectPaymentAllocation[];
    throw new Error("We could not load your direct payment allocation. Please try again.");
  }
  if ((result.data ?? []).length >= 1000) throw new Error("Too many direct payment versions to reconcile safely. Contact Workforce.");
  return (result.data ?? []) as DirectPaymentAllocation[];
}

async function directPaymentMethods(companyId: string, allocations: DirectPaymentAllocation[]) {
  const methodIds = [...new Set(allocations.map((allocation) => allocation.payment_method_id).filter(Boolean))];
  if (!methodIds.length) return [] as DirectPaymentMethod[];
  const result = await db().from("payment_methods")
    .select("id,code,name,payment_method_components(component_code,component_type,label,pay_schedule,sort_order,is_active,payment_fields(code,label,field_type,pay_schedule,calculation_type,calculation_source))")
    .eq("company_id", companyId)
    .in("id", methodIds);
  if (result.error) throw new Error("We could not load your direct payment method. Please try again.");
  return (result.data ?? []) as unknown as DirectPaymentMethod[];
}

export async function loadWorkforcePaymentPolicyHistory(companyId: string, through: string) {
  const result = await db().from("workforce_payment_settings")
    .select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from")
    .eq("company_id", companyId)
    .lte("effective_from", through)
    .order("effective_from");
  if (result.error) throw new Error("We could not load the Workforce payment policy. Please try again.");
  return (result.data ?? []) as WorkforcePaymentPolicy[];
}

export async function loadWorkforceAttendanceCaptureHistory(companyId: string, through: string) {
  const result = await db().from("workforce_attendance_capture_settings")
    .select("id,capture_method,minimum_daily_deliveries,effective_from")
    .eq("company_id", companyId)
    .lte("effective_from", through)
    .order("effective_from");
  if (result.error) throw new Error("We could not load the Workforce attendance source. Please try again.");
  return (result.data ?? []) as WorkforceAttendanceCaptureSetting[];
}

export async function loadDirectPaymentSetup(input: {
  companyId: string;
  workforceId: string | null;
  from: string;
  to: string;
}) {
  const [policyHistory, attendanceCaptureHistory] = await Promise.all([
    loadWorkforcePaymentPolicyHistory(input.companyId, input.to),
    loadWorkforceAttendanceCaptureHistory(input.companyId, input.to)
  ]);
  if (!input.workforceId) return { allocations: [] as DirectPaymentAllocation[], methods: [] as DirectPaymentMethod[], policyHistory, attendanceCaptureHistory };
  const allocations = await directAllocationRows(input.companyId, input.workforceId, input.from, input.to);
  const methods = await directPaymentMethods(input.companyId, allocations);
  return { allocations, methods, policyHistory, attendanceCaptureHistory };
}

export async function loadDirectPaymentContext(input: {
  companyId: string;
  workforceId: string | null;
  from: string;
  to: string;
  employmentFrom?: string | null;
  employmentTo?: string | null;
  sourceProfileId?: string | null;
  sourceProfileType?: string | null;
}) {
  const setup = await loadDirectPaymentSetup(input);
  if (!input.workforceId || !setup.allocations.length) return { ...setup, attendance: [] as DirectAttendanceDay[], days: [] };
  const accrualFrom = [input.from, input.employmentFrom || input.from].sort().at(-1)!;
  const accrualTo = [input.to, input.employmentTo || input.to].sort()[0];
  if (accrualFrom > accrualTo) return { ...setup, attendance: [] as DirectAttendanceDay[], days: [] };
  const methodsById = new Map(setup.methods.map((method) => [method.id, method]));
  const needsAttendanceSource = setup.allocations.some((allocation) => {
    const components = allocation.payment_components?.length
      ? allocation.payment_components
      : methodsById.get(allocation.payment_method_id)?.payment_method_components ?? [];
    return components.some((component) => {
      const field = Array.isArray(component.payment_fields) ? component.payment_fields[0] : component.payment_fields;
      return String(field?.calculation_source ?? component.calculation_source ?? "").trim().toLowerCase() === "attendance_eligibility";
    });
  });
  if (needsAttendanceSource) {
    for (let cursor = new Date(`${accrualFrom}T00:00:00Z`); cursor <= new Date(`${accrualTo}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      if (workforceAttendanceCaptureSettingForDate(setup.attendanceCaptureHistory, date).capture_method === "shipment_data") {
        throw new Error("Shipment attendance requires a provider mapping. Direct-pay workforce must use biometric attendance or a separately supported attendance source.");
      }
    }
  }
  const attendanceResult = await db().from("attendance_daily")
    .select("id,punch_date,status,in_time,out_time,work_minutes")
    .eq("company_id", input.companyId)
    .or(attendanceIdentityFilter({ id: input.workforceId, source_profile_id: input.sourceProfileId ?? null, source_profile_type: input.sourceProfileType ?? null }))
    .gte("punch_date", workforcePaymentMonthStart(accrualFrom))
    .lte("punch_date", accrualTo)
    .order("punch_date")
    .limit(1000);
  if (attendanceResult.error) throw new Error("We could not load the attendance used for your direct earnings. Please try again.");
  if ((attendanceResult.data ?? []).length >= 1000) throw new Error("Too many attendance records to reconcile safely. Contact Workforce.");
  const attendance = (attendanceResult.data ?? []) as DirectAttendanceDay[];
  const days = calculateDirectWorkforcePayments({ ...setup, attendance, from: accrualFrom, to: accrualTo });
  return { ...setup, attendance, days };
}

export function paymentMethodById(methods: DirectPaymentMethod[]) {
  return new Map(methods.map((method) => [method.id, method]));
}
