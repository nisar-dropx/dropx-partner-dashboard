import "server-only";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export function mayApprovePaymentRelease(auth: AuthorizationContext) {
  if (auth.readOnly) return false;
  return [auth.roleCode, ...(auth.effectiveRoleCodes ?? []), auth.designationName].some(value =>
    /^(SLPM|SLP_MANAGER|NH|NATIONAL_HEAD|FINMGR|FINANCE_MANAGER|MP|MANAGING_PARTNER|SALES_MANAGER)$/.test(
      String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^(OPERATIONS|FINANCE|PEOPLE|WORKFORCE)_/, "")
    )
  );
}

export async function paymentReleaseAccess(edit = false, finance = false) {
  const auth = await getAuthorization();
  if (!auth || (edit && auth.readOnly)) throw Error("Sign in with permission to review payment release.");
  const financePermission = hasPermission(auth, "payment_process", edit ? "edit" : "view");
  if (finance ? !financePermission : !["ops_losses", "workforce_payouts", "ops_workforce_payouts", "payment_process"].some(page => hasPermission(auth, page, "view"))) {
    throw Error("You do not have access to this payment review.");
  }
  if (!supabaseAdmin) throw Error("Payment release checks are unavailable. Please retry.");
  return { auth, company: requireCompanyId(auth), db: supabaseAdmin };
}

export async function assertReleaseStation(auth: AuthorizationContext, company: string, station: string) {
  if (!/^[0-9a-f-]{36}$/i.test(station) || (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(station))) {
    throw Error("Station outside your access.");
  }
  const result = await supabaseAdmin!.from("stations").select("id").eq("company_id", company).eq("id", station).maybeSingle();
  if (result.error || !result.data) throw Error("The selected station is unavailable.");
}

export async function assertPaymentRelease(company: string, stations: string[], month: string, scope: string) {
  for (const station of [...new Set(stations)]) {
    const result = await supabaseAdmin!.rpc("assert_loss_payment_release", {
      p_company: company, p_station: station, p_month: month, p_scope: scope
    });
    if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Loss clearance could not be verified. Bank download is blocked.");
  }
}
