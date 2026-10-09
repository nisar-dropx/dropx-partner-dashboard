import type { SupabaseClient } from "@supabase/supabase-js";
import { buildInterimSalary, canViewInterimSalary, type SalaryDocument, type SalaryPayment, type SalaryPerson, type SalaryRun } from "./interim-salary";

export async function loadInterimSalaries(db: SupabaseClient, account: { id: string; companyId: string; profileType: string; workspace?: string; activationOnly?: boolean }) {
  if (!canViewInterimSalary(account)) throw new Error("Salary is available only in your People workspace.");
  // Every person lookup is company + canonical worker type + authenticated worker ID scoped.
  const [bank, docs] = await Promise.all([
    db.from("hr_payroll_bank_lines").select("id,run_id,amount,status,value_date,reference,utr,attempt")
      .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id).order("created_at", { ascending: false }).limit(500),
    db.from("hr_pay_documents").select("id,run_id,published_at")
      .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id).is("revoked_at", null).order("published_at", { ascending: false }).limit(100)
  ]);
  if (bank.error || docs.error) throw new Error("Unable to load salary payment history. Please retry.");
  // Fail explicitly rather than presenting a truncated total as a full salary ledger.
  if ((bank.data?.length ?? 0) >= 500 || (docs.data?.length ?? 0) >= 100) throw new Error("Salary history needs a narrower period. Please contact People.");
  const payments = (bank.data ?? []) as SalaryPayment[];
  const documents = (docs.data ?? []) as SalaryDocument[];
  const runIds = [...new Set([...payments, ...documents].map(row => row.run_id))];
  if (!runIds.length) return [];
  // Unreleased internal drafts have no bank history/document and stay private.
  const [runs, people] = await Promise.all([
    db.from("hr_payroll_runs").select("id,label,period_start,period_end,calculation_from,calculation_through,calculated_at,status")
      .eq("company_id", account.companyId).in("id", runIds).order("period_start", { ascending: false }).order("created_at", { ascending: false }),
    db.from("hr_payroll_run_people").select("id,run_id,gross_pay,other_earnings,net_pay,adjusted_net_pay,payable_days,expected_days,present_days,half_days,absence_days,paid_leave_days,weekoff_days,missing_punch_days,hr_payroll_run_items(code,name,item_type,amount,display_order)")
      .eq("company_id", account.companyId).eq("worker_type", account.profileType).eq("worker_id", account.id).in("run_id", runIds)
  ]);
  if (runs.error || people.error) throw new Error("Unable to load the salary breakup. Please retry.");
  return ((runs.data ?? []) as SalaryRun[]).map(run => buildInterimSalary(run,
    ((people.data ?? []) as SalaryPerson[]).find(row => row.run_id === run.id) ?? null,
    payments, documents.find(row => row.run_id === run.id) ?? null));
}
