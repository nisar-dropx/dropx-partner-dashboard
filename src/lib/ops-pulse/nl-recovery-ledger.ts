import { readAllRows } from "@/lib/supabase-pagination";
import { mayActivateRedispute } from "@/lib/ops-pulse/loss-recovery-controls";
import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "./nl-loss";
import { ledgerTotals, type LedgerLine, type LedgerStatus } from "./nl-recovery-ledger-view";

export type { LedgerLine } from "./nl-recovery-ledger-view";

/** Every recovery plan line in the user's stations, with what payroll deducted and what is still due. */
export async function loadRecoveryLedger(auth: AuthorizationContext, fromMonth?: string | null) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const { company, stations } = await nlStationScope(auth);
  const allowed = new Set(stations.map((s) => s.source_code));
  const from = fromMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth) ? fromMonth : null;
  const result = await readAllRows(supabaseAdmin.rpc("nl_recovery_ledger", { p_company: company, p_from_month: from, p_ref: null }).order("month").order("case_key").order("employee_ref"));
  if (result.error) {
    // Before the instalments migration is applied the ledger is simply not available yet.
    if (result.error.code === "PGRST202" || result.error.code === "42883")
      return { ready: false as const, lines: [] as LedgerLine[], totals: ledgerTotals([]), canWriteOff: false };
    throw Error("The recovery ledger could not be loaded.");
  }
  const [plans,grants]=await Promise.all([
    readAllRows(supabaseAdmin.from("nl_loss_recoveries").select("month,case_key,approval_status,allocations,source_amount,source_status").eq("company_id",company).eq("is_deleted",false).order("month").order("case_key")),
    readAllRows(supabaseAdmin.from("nl_loss_exception_options").select("month,case_key,source_amount,source_status").eq("company_id",company).eq("kind","write_off").eq("enabled",true).order("month").order("case_key"))
  ]);
  if(plans.error) throw Error("Collection approval states could not be loaded.");
  if(grants.error) throw Error("Write-off exceptions could not be loaded.");
  const byCase=new Map((plans.data || []).map(p=>[`${p.month}|${p.case_key}`,p]));
  const writeOff=new Set((grants.data || []).filter(g=>{
    const p=byCase.get(`${g.month}|${g.case_key}`);
    return p && Number(p.source_amount)===Number(g.source_amount) && p.source_status===g.source_status;
  }).map(g=>`${g.month}|${g.case_key}`));
  const funded=new Map<string,number>();
  const approval=new Map((plans.data||[]).map(p=>[`${p.month}|${p.case_key}`,p.approval_status]));
  const designations = new Map<string,string>();
  for(const p of plans.data || []) for(const a of (Array.isArray(p.allocations)?p.allocations:[]) as {ref?:string;designation?:string;payroll_amount?:number}[]) {
    if(a.ref && a.designation) designations.set(`${p.month}|${p.case_key}|${a.ref}`,a.designation);
    if(a.ref && a.payroll_amount!=null) funded.set(`${p.month}|${p.case_key}|${a.ref}`,Number(a.payroll_amount));
  }
  const lines = ((result.data ?? []) as LedgerLine[])
    .filter((l) => allowed.has(String(l.station_code ?? "").trim().toUpperCase()))
    .map((l) => ({
      ...l,
      write_off_enabled:writeOff.has(`${l.month}|${l.case_key}`),
      funded_pending:Math.max(0,(funded.get(`${l.month}|${l.case_key}|${l.employee_ref}`) || 0)-Number(l.deducted)),
      designation: designations.get(`${l.month}|${l.case_key}|${l.employee_ref}`) || null,
      status: (!l.status.startsWith("redispute_") && Number(l.outstanding)>0 && ["none","proposed","returned","needs_review"].includes(approval.get(`${l.month}|${l.case_key}`) || "")
        ? approval.get(`${l.month}|${l.case_key}`)==="returned" ? "returned" : approval.get(`${l.month}|${l.case_key}`)==="needs_review" ? "needs_review" : "awaiting_approval" : l.status) as LedgerStatus,
      total: Number(l.total),
      deducted: Number(l.deducted),
      in_payroll: Number(l.in_payroll),
      waived: Number(l.waived),
      outstanding: Number(l.outstanding),
      monthly_amount: Number(l.monthly_amount),
    }));
  return {
    ready: true as const,
    lines,
    totals: ledgerTotals(lines),
    canWriteOff: mayActivateRedispute(auth) && hasPermission(auth, "ops_loss_master", "edit"),
  };
}
