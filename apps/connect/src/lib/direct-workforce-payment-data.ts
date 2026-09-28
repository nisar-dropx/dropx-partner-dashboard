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

export type CanonicalPaymentWorker = {
  id: string;
  designation_id: string | null;
  location_id: string | null;
  date_of_join: string | null;
  last_working_date: string | null;
  source_profile_id: string | null;
  source_profile_type: string | null;
};

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

export async function loadDirectPaymentSetup(input: {
  companyId: string;
  workforceId: string | null;
  from: string;
  to: string;
}) {
  if (!input.workforceId) return { allocations: [] as DirectPaymentAllocation[], methods: [] as DirectPaymentMethod[] };
  const allocations = await directAllocationRows(input.companyId, input.workforceId, input.from, input.to);
  const methods = await directPaymentMethods(input.companyId, allocations);
  return { allocations, methods };
}

export async function loadDirectPaymentContext(input: {
  companyId: string;
  workforceId: string | null;
  from: string;
  to: string;
  employmentFrom?: string | null;
  employmentTo?: string | null;
}) {
  const setup = await loadDirectPaymentSetup(input);
  if (!input.workforceId || !setup.allocations.length) return { ...setup, attendance: [] as DirectAttendanceDay[], days: [] };
  const accrualFrom = [input.from, input.employmentFrom || input.from].sort().at(-1)!;
  const accrualTo = [input.to, input.employmentTo || input.to].sort()[0];
  if (accrualFrom > accrualTo) return { ...setup, attendance: [] as DirectAttendanceDay[], days: [] };
  const attendanceResult = await db().from("attendance_daily")
    .select("id,punch_date,status,in_time,out_time,work_minutes")
    .eq("company_id", input.companyId)
    .eq("workforce_id", input.workforceId)
    .gte("punch_date", accrualFrom)
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
