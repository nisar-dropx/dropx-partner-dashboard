import { hasPermission, requirePagePermissionOrThrow } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { notifyAssociateOfPayoutDispute } from "@/lib/payout-dispute-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildDisputeCorrectionPlan, payoutDisputeCorrectionFields } from "@/lib/payout-dispute-corrections";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set([
  "propose_correction",
  "propose_rejection",
  "approve_final",
  "send_back",
  "claim_processing",
  "block_processing",
  "complete_processing"
]);

function wholePaise(value: string) {
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type PayoutReviewResult = { action: string; status: string };

/**
 * Advances one payout dispute through the configured three-person workflow.
 * The database rechecks stage role, station scope, actor separation, version,
 * and revised-publication evidence under a row lock.
 */
export async function performPayoutReview(form: FormData): Promise<PayoutReviewResult> {
  const ops = currentAdminAccessSurface() === "ops";
  const pageCode = ops ? "ops_workforce_payout_disputes" : "workforce_payout_disputes";
  const auth = await requirePagePermissionOrThrow(pageCode, "edit");
  if (auth.readOnly || !supabaseAdmin) throw new Error("Editing is unavailable.");

  const text = (key: string) => String(form.get(key) || "").trim();
  const action = text("transition");
  const disputeId = text("dispute_id");
  const expectedVersion = Number(text("expected_version"));
  const note = text("note").slice(0, 1000);
  if (!ACTIONS.has(action)) throw new Error("Choose a valid dispute action.");
  if (!UUID.test(disputeId)) throw new Error("This dispute is invalid. Refresh and try again.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("This dispute changed. Refresh and try again.");

  const payoutPageCode = ops ? "ops_workforce_payouts" : "workforce_payouts";
  if (["claim_processing", "block_processing", "complete_processing"].includes(action)) {
    if (!hasPermission(auth, payoutPageCode, "edit")) throw new Error("Processing also requires edit permission for Workforce Payouts.");
  }

  const payload: Record<string, unknown> = { note: note || null, portal: ops ? "ops" : "workforce" };
  const companyId = requireCompanyId(auth);
  if (action === "propose_correction") {
    let query = supabaseAdmin.from("workforce_payout_disputes").select("reason,category,publication_id,version").eq("company_id", companyId).eq("id", disputeId);
    if (!auth.hasAllLocationAccess) query = query.in("station_id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
    const dispute = await query.single();
    if (dispute.error || !dispute.data || dispute.data.version !== expectedVersion) throw new Error("This dispute changed or is unavailable. Refresh and try again.");
    const publication = await supabaseAdmin.from("workforce_payout_publications").select("snapshot").eq("company_id", companyId).eq("id", dispute.data.publication_id).single();
    if (publication.error || !publication.data) throw new Error("The disputed payout could not be loaded. Refresh and try again.");
    payload.correction_plan = buildDisputeCorrectionPlan(
      payoutDisputeCorrectionFields(dispute.data.reason, dispute.data.category, publication.data.snapshot), form
    );
  }
  if (action === "complete_processing") {
    const publicationId = text("processed_publication_id");
    const before = text("before_net_paise");
    const after = text("after_net_paise");
    const beforePaise = wholePaise(before);
    const afterPaise = wholePaise(after);
    if (!UUID.test(publicationId) || beforePaise == null || afterPaise == null) {
      throw new Error("A newer revised payout publication with a verifiable net change is required before completion.");
    }
    payload.processed_publication_id = publicationId;
    payload.processing_result = {
      before_net_paise: beforePaise,
      after_net_paise: afterPaise
    };
  }

  const result = await supabaseAdmin.rpc("workforce_dispute_transition_v2", {
    p_company: companyId,
    p_dispute: disputeId,
    p_actor: auth.userId,
    p_actor_name: auth.fullName || auth.email || "Authorised reviewer",
    p_actor_role_ids: auth.effectiveRoleIds,
    p_action: action,
    p_expected_version: expectedVersion,
    p_locations: auth.hasAllLocationAccess ? null : auth.locationScopeIds,
    p_payload: payload
  });
  if (result.error) throw new Error(result.error.code === "P0001" ? result.error.message : "The dispute could not be updated.");

  const saved = result.data as Record<string, unknown> | null;
  if (!saved) throw new Error("The dispute was updated but its new status could not be confirmed.");
  try {
    await notifyAssociateOfPayoutDispute({ action, companyId, dispute: saved });
  } catch (error) {
    // The transition is authoritative. A temporary push failure must not make
    // the operator repeat an already completed approval or correction.
    console.error("Unable to notify associate about payout dispute:", error);
  }
  return { action, status: String(saved.status || "") };
}
