import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
export type SalaryHoldContext = { employee_ref: string; salary_month: string; actor_name: string | null; actor_id: string | null; reason: string | null };
export async function loadSalaryHoldContext(company: string, refs: string[], months: string[]): Promise<SalaryHoldContext[]> {
  if (!refs.length || !months.length) return [];
  const result = await supabaseAdmin!.rpc("salary_hold_context", {p_company: company, p_refs: refs, p_months: months});
  if (result.error) throw new Error("Salary hold information could not be checked. Please retry.");
  return result.data ?? [];
}
