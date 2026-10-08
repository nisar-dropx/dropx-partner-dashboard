import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function performPayoutReview(form: FormData) {
  const auth = await requirePagePermission("workforce_payout_disputes", "edit");
  if (auth.readOnly || !supabaseAdmin) throw new Error("Editing is unavailable.");

  const text = (key: string) => String(form.get(key) || "").trim();
  const decision = text("decision");
  if (text("operation") !== "decision" || !["resolved", "rejected"].includes(decision)) {
    throw new Error("Choose Resolve or Reject.");
  }

  const result = await supabaseAdmin.rpc("workforce_decide_payout_dispute", {
    p_company: requireCompanyId(auth),
    p_dispute: text("dispute_id"),
    p_actor: auth.userId,
    p_actor_name: auth.fullName || auth.email || "Authorised reviewer",
    p_decision: decision,
    p_locations: auth.hasAllLocationAccess ? null : auth.locationScopeIds
  });
  if (result.error) throw new Error(result.error.message);
}
