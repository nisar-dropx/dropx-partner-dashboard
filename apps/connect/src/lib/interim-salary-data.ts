import type { SupabaseClient } from "@supabase/supabase-js";
import { buildInterimSalary, canViewInterimSalary, type LeaveCover, type SalaryDocument, type SalaryPayment, type SalaryPerson, type SalaryRun } from "./interim-salary";

/** People-side calculation is visible once ready. Draft payroll stays private. */
const VISIBLE_RUN_STATUSES = ["calculated", "reviewed", "approved", "locked"] as const;

export async function loadInterimSalaries(db: SupabaseClient, account: { id: string; companyId: string; profileType: string; workspace?: string; activationOnly?: boolean }) {
  if (!canViewInterimSalary(account)) throw new Error("Salary is available only in your People workspace.");
  // Salary Calculation lists ready People breakups. Payslips stay document-gated separately.
  const peopleResult = await db.from("hr_payroll_run_people")
    .select("id,run_id,gross_pay,other_earnings,net_pay,adjusted_net_pay,payable_days,expected_days,present_days,half_days,absence_days,paid_leave_days,weekoff_days,missing_punch_days,calculation_snapshot,hr_payroll_run_items(code,name,item_type,amount,display_order,source,metadata)")
    .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id)
    .eq("calculation_status", "ready").limit(100);
  if (peopleResult.error) throw new Error("Unable to load the salary breakup. Please retry.");
  if ((peopleResult.data?.length ?? 0) >= 100) throw new Error("Salary history needs a narrower period. Please contact People.");
  const peopleRows = (peopleResult.data ?? []) as SalaryPerson[];
  const runIds = [...new Set(peopleRows.map(row => row.run_id).filter(Boolean))];
  if (!runIds.length) return [];

  const [runs, bank, docs] = await Promise.all([
    db.from("hr_payroll_runs").select("id,label,period_start,period_end,calculation_from,calculation_through,calculated_at,status")
      .eq("company_id", account.companyId).in("id", runIds).in("status", [...VISIBLE_RUN_STATUSES])
      .order("period_start", { ascending: false }).order("created_at", { ascending: false }),
    db.from("hr_payroll_bank_lines").select("id,run_id,amount,status,value_date,reference,utr,attempt")
      .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id)
      .in("run_id", runIds).order("created_at", { ascending: false }).limit(500),
    db.from("hr_pay_documents").select("id,run_id,published_at")
      .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id)
      .in("run_id", runIds).is("revoked_at", null).order("published_at", { ascending: false }).limit(100)
  ]);
  if (runs.error || bank.error || docs.error) throw new Error("Unable to load the salary breakup. Please retry.");
  if ((bank.data?.length ?? 0) >= 500 || (docs.data?.length ?? 0) >= 100) throw new Error("Salary history needs a narrower period. Please contact People.");

  const payments = (bank.data ?? []) as SalaryPayment[];
  const documents = (docs.data ?? []) as SalaryDocument[];
  const leaves = peopleRows.some(row => Array.isArray(row.calculation_snapshot?.payable_fractions))
    ? await loadLeaveCovers(db, account) : [];
  const visibleStatus = new Set<string>(VISIBLE_RUN_STATUSES);
  return ((runs.data ?? []) as SalaryRun[])
    .filter(run => visibleStatus.has(run.status))
    .map(run => buildInterimSalary(run,
      peopleRows.find(row => row.run_id === run.id) ?? null,
      payments, documents.find(row => row.run_id === run.id) ?? null, leaves));
}

async function loadLeaveCovers(db: SupabaseClient, account: { id: string; companyId: string; profileType: string }): Promise<LeaveCover[]> {
  const idColumn = account.profileType === "contractor" ? "contractor_id" : "employee_id";
  const result = await db.from("hr_leave_requests").select("start_date,end_date,hr_leave_types(code,name,attendance_code)")
    .eq("company_id", account.companyId).eq(idColumn, account.id).eq("status", "approved").limit(500);
  if (result.error) throw new Error("Unable to load the salary breakup. Please retry.");
  if ((result.data?.length ?? 0) >= 500) throw new Error("Salary history needs a narrower period. Please contact People.");
  return ((result.data ?? []) as Array<{ start_date: string; end_date: string; hr_leave_types: { code?: string; name?: string; attendance_code?: string } | { code?: string; name?: string; attendance_code?: string }[] | null }>).map(row => {
    const type = Array.isArray(row.hr_leave_types) ? row.hr_leave_types[0] : row.hr_leave_types;
    return { start: row.start_date, end: row.end_date, code: String(type?.attendance_code || type?.code || ""), name: String(type?.name || "") };
  });
}
