import "server-only";
import { type AuthorizationContext, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { nlStationScope } from "./nl-loss";
import type { LossDebit } from "./loss-debit-review";
export async function loadLossDebits(auth: AuthorizationContext) {
  if (!hasPermission(auth, "ops_losses", "access"))
    throw Error("Access denied.");
  const { company, stations } = await nlStationScope(auth);
  const codes = new Set(stations.map((s) => s.source_code));
  const res = await readAllRows(
    supabaseAdmin!
      .rpc("nl_recovery_payroll_status", { p_company: company })
      .order("payroll_month")
      .order("recovery_key"),
  );
  if (res.error)
    throw Error("Payroll deductions could not be loaded. Please retry.");
  const seen = new Set<string>();
  return (res.data || [])
    .filter((r) => {
      if (!codes.has(r.station_code) || seen.has(r.recovery_key)) return false;
      seen.add(r.recovery_key);
      return true;
    })
    .map((r) => ({ ...r, amount: Number(r.amount) })) as LossDebit[];
}

export async function loadCurrentLossPayrollMonth(auth: AuthorizationContext) {
  if (!hasPermission(auth, "ops_losses", "access")) throw Error("Access denied.");
  const { company } = await nlStationScope(auth);
  const result = await supabaseAdmin!.rpc("nl_recovery_current_payroll_month", { p_company: company });
  if (result.error || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(result.data ?? "")))
    throw Error("Current payroll period could not be loaded. Please retry.");
  return String(result.data);
}
