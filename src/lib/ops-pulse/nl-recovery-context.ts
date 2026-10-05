import "server-only";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "./nl-loss";
import { isRecoverable, canonicalNlCaseKey } from "./nl-loss-policy";
export async function recoveryContext(
  month: string,
  key: string,
  edit: boolean,
) {
  const auth = await getAuthorization();
  if (
    !auth ||
    !hasPermission(auth, "ops_losses", edit ? "edit" : "access") ||
    (edit && auth.readOnly)
  )
    throw Error("Access denied.");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !key ||
    key.length > 300 ||
    !supabaseAdmin
  )
    throw Error("Invalid recovery case.");
  const scope = await nlStationScope(auth);
  const settings = await supabaseAdmin
    .from("nl_loss_sources")
    .select(
      "recoverable_statuses,include_inactive_people,recovery_policy,updated_at",
    )
    .eq("company_id", scope.company)
    .maybeSingle();
  let row = await supabaseAdmin
    .from("nl_loss_month_cases")
    .select("case_key,station_code,amount,source_status,source_present")
    .eq("company_id", scope.company)
    .eq("month", month)
    .eq("case_key", key)
    .maybeSingle();
  const canonicalKey = canonicalNlCaseKey(key);
  if (!row.error && !row.data?.source_present && canonicalKey !== key) {
    row = await supabaseAdmin
      .from("nl_loss_month_cases")
      .select("case_key,station_code,amount,source_status,source_present")
      .eq("company_id", scope.company)
      .eq("month", month)
      .eq("case_key", canonicalKey)
      .maybeSingle();
  }
  const station = scope.stations.find(
    (s) => s.source_code === row.data?.station_code,
  );
  if (
    row.error ||
    !station ||
    !row.data?.source_present ||
    !isRecoverable(
      row.data.source_status,
      settings.data?.recoverable_statuses ?? [],
    )
  )
    throw Error("Case is unavailable or outside your station access.");
  return {
    auth,
    scope,
    station,
    settings: settings.data,
    caseKey: row.data.case_key,
    amount: row.data.amount,
  };
}
