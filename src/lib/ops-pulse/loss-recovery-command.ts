import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { lossesDeepLink } from "./nl-loss-lifecycle-policy";
import type { CodLocationRow } from "./cod";

export type LossRecoveryCommandSummary = {
  total_recoverable: number;
  awaiting_station: number;
  awaiting_cluster: number;
  awaiting_slp: number;
  approved_not_scheduled: number;
  due_this_cycle: number;
  overdue: number;
  blocked_needs_review: number;
  blocked_exit: number;
  on_hold: number;
  by_station: Array<{ station_code: string; recoverable: number; outstanding: number }>;
  salary_month: string;
};

const empty: LossRecoveryCommandSummary = {
  total_recoverable: 0,
  awaiting_station: 0,
  awaiting_cluster: 0,
  awaiting_slp: 0,
  approved_not_scheduled: 0,
  due_this_cycle: 0,
  overdue: 0,
  blocked_needs_review: 0,
  blocked_exit: 0,
  on_hold: 0,
  by_station: [],
  salary_month: "",
};

export async function loadLossRecoveryCommand(
  auth: AuthorizationContext,
  locations: CodLocationRow[],
) {
  if (!hasPermission(auth, "ops_losses", "access") || !supabaseAdmin) {
    return { summary: null as LossRecoveryCommandSummary | null, hrefs: {} as Record<string, string> };
  }
  const company = requireCompanyId(auth);
  const codes = locations.map((l) => l.station_code).filter(Boolean);
  if (!codes.length) return { summary: empty, hrefs: {} };
  const { data, error } = await supabaseAdmin.rpc("nl_loss_recovery_command_summary", {
    p_company: company,
    p_stations: codes,
    p_salary_month: null,
  });
  if (error) {
    if (/does not exist|schema cache|nl_loss_recovery_command_summary/i.test(error.message)) {
      return { summary: null, hrefs: {} };
    }
    throw Error(error.message);
  }
  const summary = (data ?? empty) as LossRecoveryCommandSummary;
  const month = summary.salary_month || new Date().toISOString().slice(0, 7);
  const hrefs = {
    station: lossesDeepLink({ month, lifecycle: "station_dispute_or_clarification_window" }),
    cluster: lossesDeepLink({ month, lifecycle: "cluster_validation_pending" }),
    slp: lossesDeepLink({ month, lifecycle: "slp_final_confirmation_pending" }),
    due: lossesDeepLink({ month, lifecycle: "recovery_approved_scheduled" }),
    review: lossesDeepLink({ month, lifecycle: "needs_review" }),
    all: lossesDeepLink({ month }),
  };
  return { summary, hrefs };
}
