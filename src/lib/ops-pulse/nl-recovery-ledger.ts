import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "./nl-loss";
import { ledgerTotals, type LedgerLine } from "./nl-recovery-ledger-view";

export type { LedgerLine } from "./nl-recovery-ledger-view";

/** Every recovery plan line in the user's stations, with what payroll deducted and what is still due. */
export async function loadRecoveryLedger(auth: AuthorizationContext, fromMonth?: string | null) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const { company, stations } = await nlStationScope(auth);
  const allowed = new Set(stations.map((s) => s.source_code));
  const from = fromMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth) ? fromMonth : null;
  const result = await supabaseAdmin.rpc("nl_recovery_ledger", { p_company: company, p_from_month: from, p_ref: null });
  if (result.error) {
    // Before the instalments migration is applied the ledger is simply not available yet.
    if (result.error.code === "PGRST202" || result.error.code === "42883")
      return { ready: false as const, lines: [] as LedgerLine[], totals: ledgerTotals([]), canWriteOff: false };
    throw Error("The recovery ledger could not be loaded.");
  }
  const lines = ((result.data ?? []) as LedgerLine[])
    .filter((l) => allowed.has(String(l.station_code ?? "").trim().toUpperCase()))
    .map((l) => ({
      ...l,
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
    canWriteOff: hasPermission(auth, "ops_loss_master", "edit") && !auth.readOnly,
  };
}
