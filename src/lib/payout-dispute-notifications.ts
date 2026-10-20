import "server-only";

import { createAppNotification, type AppNotificationEvent } from "@/lib/app-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutDeepLink } from "@/lib/workforce-payout-whatsapp";

type DisputeEvent = Extract<
  AppNotificationEvent,
  "payout_dispute_approved" | "payout_dispute_rejected" | "payout_dispute_resolved"
>;
type Notice = { eventCode: DisputeEvent; decision: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function payoutRoute(companyId: string, dispute: Record<string, unknown>) {
  const fallback = workforcePayoutDeepLink(null, {});
  const publicationId = String(dispute.processed_publication_id || dispute.publication_id || "");
  if (!supabaseAdmin || !UUID.test(publicationId)) return fallback;

  const publication = await supabaseAdmin
    .from("workforce_payout_publications")
    .select("snapshot")
    .eq("company_id", companyId)
    .eq("id", publicationId)
    .maybeSingle();
  if (publication.error || !publication.data?.snapshot) return fallback;
  const snapshot = publication.data.snapshot as Parameters<typeof workforcePayoutDeepLink>[0];
  const item = snapshot?.item ?? {};
  return workforcePayoutDeepLink(snapshot, { dropx_id: item.dropx_id });
}

function noticeFor(action: string, dispute: Record<string, unknown>): Notice | null {
  const status = String(dispute.status || "");
  if (action === "approve_final" && status === "approved_for_processing") {
    return {
      eventCode: "payout_dispute_approved",
      decision: "Your payout dispute was approved. The payout team is now applying the correction."
    };
  }
  if (action === "approve_final" && status === "rejected") {
    return {
      eventCode: "payout_dispute_rejected",
      decision: String(dispute.resolution || dispute.proposed_note || "Your payout dispute was not approved.")
    };
  }
  if (action === "complete_processing" && status === "resolved") {
    return {
      eventCode: "payout_dispute_resolved",
      decision: String(dispute.resolution || "Your payout correction has been processed and the revised payout is available.")
    };
  }
  return null;
}

export async function notifyAssociateOfPayoutDispute({
  action,
  companyId,
  dispute
}: {
  action: string;
  companyId: string;
  dispute: Record<string, unknown>;
}) {
  if (!supabaseAdmin) return;
  const notice = noticeFor(action, dispute);
  const workforceId = String(dispute.workforce_id || "");
  const disputeId = String(dispute.id || "");
  if (!notice || !workforceId || !disputeId) return;

  const route = await payoutRoute(companyId, dispute);
  await createAppNotification({
    accountId: workforceId,
    companyId,
    data: { disputeId, status: dispute.status, tab: "payouts" },
    eventCode: notice.eventCode,
    profileType: "workforce",
    routeOverride: route,
    sourceKey: `${disputeId}:${String(dispute.version || "")}:${String(dispute.status || "")}`,
    variables: { decision: notice.decision }
  });
}
