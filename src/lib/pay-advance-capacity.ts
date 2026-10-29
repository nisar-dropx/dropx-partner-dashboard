import "server-only";

import { ADVANCE_ELIGIBILITY_PERCENT, advanceEligibilityAmount } from "@/lib/advance-eligibility";
import type { AuthorizationContext } from "@/lib/authorization";
import { payableBalanceMonthRange, roundPayableMoney } from "@/lib/payable-balance";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";

type SupportedAdvanceProfile = "employee" | "contractor" | "workforce";

function monthOffset(month: string, offset: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function allLocationContext(companyId: string): AuthorizationContext {
  return {
    companyCode: null, companyId, companyName: null, email: null,
    effectiveRoleIds: [], fullName: null, hasAllLocationAccess: true,
    isMasterCompany: false, isMasterOwner: false, locationScopeIds: [],
    permissions: {}, roleCode: null, roleId: null, roleName: null,
    userId: "00000000-0000-0000-0000-000000000000"
  };
}

async function workforceMonthBalance(companyId: string, workforceId: string, month: string) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const range = payableBalanceMonthRange(month);
  if (!range) return 0;
  const [worksheet, paid] = await Promise.all([
    loadWorkforcePayoutRows(companyId, allLocationContext(companyId), range.start, range.end, {
      workforceIds: [workforceId], includeLossRecoveries: true
    }),
    supabaseAdmin.from("workforce_payout_effective_paid_allocations")
      .select("settled_amount_snapshot")
      .eq("company_id", companyId)
      .eq("credited_workforce_id", workforceId)
      .eq("period_start", range.start)
      .eq("period_end", range.end)
  ]);
  if (worksheet.error) throw new Error(`Unable to calculate the outstanding payout: ${worksheet.error}`);
  if (paid.error) throw new Error(`Unable to verify paid payouts: ${paid.error.message}`);
  const target = worksheet.rows.reduce((sum, row) => sum + Math.max(0, Number(row.netAmount ?? 0)), 0);
  const settled = (paid.data ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.settled_amount_snapshot ?? 0)), 0);
  return Math.max(0, roundPayableMoney(target - settled));
}

async function peopleMonthBalance(companyId: string, profileType: "employee" | "contractor", workerId: string, month: string) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const range = payableBalanceMonthRange(month);
  if (!range) return 0;
  const run = await supabaseAdmin.from("hr_payroll_runs")
    .select("id").eq("company_id", companyId).eq("period_start", range.start).eq("period_end", range.end)
    .in("status", ["draft", "calculated", "reviewed", "approved", "locked"])
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (run.error) throw new Error(run.error.message);
  if (!run.data) return 0;
  const [person, paid] = await Promise.all([
    supabaseAdmin.from("hr_payroll_run_people")
      .select("id,net_pay,adjusted_net_pay")
      .eq("company_id", companyId).eq("run_id", run.data.id)
      .eq("worker_type", profileType).eq("worker_id", workerId).maybeSingle(),
    supabaseAdmin.from("hr_payroll_bank_lines")
      .select("amount").eq("company_id", companyId).eq("run_id", run.data.id)
      .eq("worker_type", profileType).eq("worker_id", workerId).eq("status", "paid")
  ]);
  if (person.error || paid.error) throw new Error(person.error?.message ?? paid.error?.message ?? "Unable to calculate outstanding salary.");
  const target = Number(person.data?.adjusted_net_pay ?? person.data?.net_pay ?? 0);
  const settled = (paid.data ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  if(!person.data) return 0;
  const [due,items]=await Promise.all([
    supabaseAdmin.rpc("pay_advance_due",{p_company:companyId,p_worker_type:profileType,p_worker:workerId,
      p_period:range.start,p_target_kind:"people",p_target_key:`${run.data.id}:${profileType}:${workerId}`}),
    supabaseAdmin.from("hr_payroll_run_items").select("amount").eq("company_id",companyId)
      .eq("run_person_id",person.data.id).in("source",["pay_advance","unified_advance"])
  ]);
  if(due.error||items.error) throw new Error("Current paid advance deductions could not be verified.");
  const pendingDeduction=Math.max(0,(due.data??[]).reduce((sum:number,d:{amount:unknown})=>sum+Number(d.amount),0)
    -(items.data??[]).reduce((sum,i)=>sum+Number(i.amount),0));
  return Math.max(0, roundPayableMoney(target - settled - pendingDeduction));
}

export async function loadPayAdvanceCapacity(input: {
  companyId: string;
  profileType: SupportedAdvanceProfile;
  accountId: string;
  excludeRequestId?: string;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const currentMonth = today.slice(0, 7);
  const months = [monthOffset(currentMonth, -1), currentMonth];
  const balances = await Promise.all(months.map((month) => input.profileType === "workforce"
    ? workforceMonthBalance(input.companyId, input.accountId, month)
    : peopleMonthBalance(input.companyId, input.profileType, input.accountId, month)));
  const outstandingPay = roundPayableMoney(balances.reduce((sum, value) => sum + value, 0));
  const active = await supabaseAdmin.from("hr_pay_advance_requests")
    .select("id,requested_amount,approved_amount,status")
    .eq("company_id", input.companyId).eq("worker_type", input.profileType).eq("worker_id", input.accountId)
    .in("status", ["pending", "approved"]);
  if (active.error) throw new Error(active.error.message);
  const committedAdvance = roundPayableMoney((active.data ?? []).filter(row=>row.id!==input.excludeRequestId).reduce((sum, row) =>
    sum + Number(row.approved_amount ?? row.requested_amount ?? 0), 0));
  return {
    outstandingPay,
    committedAdvance,
    eligibilityPercent: ADVANCE_ELIGIBILITY_PERCENT,
    maxEligibleAmount: advanceEligibilityAmount(outstandingPay, committedAdvance),
    breakdown: months.map((month, index) => ({ month, outstanding: balances[index] }))
  };
}

export async function loadOwnWorkforceAdvanceDeduction(companyId:string,workerId:string,month:string) {
  const range=payableBalanceMonthRange(month);
  if(!range) throw new Error("Choose a valid payroll month.");
  const result=await loadWorkforcePayoutRows(companyId,allLocationContext(companyId),range.start,range.end,{
    workforceIds:[workerId],includeLossRecoveries:true
  });
  if(result.error) throw new Error(result.error);
  return roundPayableMoney(result.rows.reduce((sum,row)=>sum+row.deductionBreakdown
    .filter(line=>line.code==='ADVANCE_RECOVERY').reduce((n,line)=>n+line.amount,0),0));
}
