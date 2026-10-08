import "server-only";

import { deliverNotificationPush } from "@/lib/firebase-push";
import { supabaseAdmin } from "@/lib/supabase-admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function processWorkforcePayoutAppNotifications({
  notificationIds
}: {
  notificationIds: string[];
}) {
  if (!supabaseAdmin) return { attempted: 0 };
  const ids = [...new Set(notificationIds.map(String).filter((id) => UUID.test(id)))];
  if (!ids.length) return { attempted: 0 };

  const result = await supabaseAdmin
    .from("mob_app_notifications")
    .select("id,company_id,recipient_profile_type,recipient_account_id,title,body,route,data")
    .eq("event_code", "workforce_payout_review")
    .in("id", ids);
  if (result.error) throw new Error(`Unable to load payout App notifications: ${result.error.message}`);

  await Promise.all((result.data ?? []).map((notification) => deliverNotificationPush({
    id: notification.id,
    companyId: notification.company_id,
    profileType: notification.recipient_profile_type,
    accountId: notification.recipient_account_id,
    title: notification.title,
    body: notification.body,
    route: notification.route,
    data: (notification.data ?? {}) as Record<string, unknown>
  })));
  return { attempted: result.data?.length ?? 0 };
}
