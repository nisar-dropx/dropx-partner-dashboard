import { requirePagePermission } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * One step of the dispute decision: a reviewer proposes Resolve or Reject with a note for the associate,
 * and a different reviewer approves it or sends it back. The database enforces the four-eyes rule.
 */
export async function performPayoutReview(form: FormData) {
  const auth = await requirePagePermission(currentAdminAccessSurface() === "ops" ? "ops_workforce_payout_disputes" : "workforce_payout_disputes", "edit");
  if (auth.readOnly || !supabaseAdmin) throw new Error("Editing is unavailable.");

  const text = (key: string) => String(form.get(key) || "").trim();
  const step = text("step");
  const decision = text("decision");
  if (!["propose", "approve", "send_back"].includes(step)) throw new Error("Choose a review step.");
  if (step === "propose" && !["resolved", "rejected"].includes(decision)) throw new Error("Choose Resolve or Reject.");
  if (!/^[0-9a-f-]{36}$/i.test(text("dispute_id"))) throw new Error("This dispute is invalid. Refresh and try again.");

  const result = await supabaseAdmin.rpc("workforce_dispute_step", {
    p_company: requireCompanyId(auth),
    p_dispute: text("dispute_id"),
    p_actor: auth.userId,
    p_actor_name: auth.fullName || auth.email || "Authorised reviewer",
    p_step: step,
    p_decision: step === "propose" ? decision : null,
    p_note: text("note").slice(0, 1000) || null,
    p_locations: auth.hasAllLocationAccess ? null : auth.locationScopeIds
  });
  if (result.error) throw new Error(result.error.code === "P0001" ? result.error.message : "The dispute could not be updated.");
  return step;
}
