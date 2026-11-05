import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export type LossPeriodClosure = { report: string; period: string; station_code: string; closed_at: string; closed_by_name: string };

function periodCloseSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "");
  // PostgREST / Postgres when migration 20261105053755 is not applied yet.
  if (
    code === "PGRST202" ||
    code === "42883" ||
    code === "42P01" ||
    message.includes("nl_loss_period_closures") ||
    message.includes("nl_loss_assert_period_open") ||
    message.includes("could not find the function") ||
    message.includes("does not exist")
  ) {
    return "Loss period closing is not set up on this database yet. Ask Tech to apply migration 20261105053755, then retry.";
  }
  return null;
}

export async function loadLossPeriodClosures(company: string, report: string, stations: string[]) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const r = await readAllRows(supabaseAdmin.from("nl_loss_period_closures")
    .select("report,period,station_code,closed_at,closed_by_name")
    .eq("company_id", company).eq("report", report).in("station_code", stations.length ? stations : ["__NONE__"])
    .order("period").order("station_code"));
  if (r.error) throw Error(periodCloseSchemaError(r.error) || "Loss period status could not be checked. Please retry.");
  return (r.data || []) as LossPeriodClosure[];
}
export async function assertLossPeriodOpen(company: string, month: string, key: string) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const r = await supabaseAdmin.rpc("nl_loss_assert_period_open", {p_company: company, p_month: month, p_case: key});
  if (r.error) {
    throw Error(
      r.error.code === "P0001"
        ? r.error.message
        : periodCloseSchemaError(r.error) || "Loss period status could not be checked.",
    );
  }
}
