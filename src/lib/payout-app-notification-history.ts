import type { Campaign, CampaignRecipient } from "@/components/campaign-report";

export type PayoutAppNotificationHistoryRow = {
  id: string;
  recipient_account_id: string;
  recipient_profile_type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
  push_status: string;
  push_error: string | null;
};

export type PayoutAppNotificationCampaignRow = {
  id: string;
  campaign_code: string;
  created_at: string;
  mob_app_notifications?: PayoutAppNotificationHistoryRow[] | null;
};

function recipientStatus(notification: PayoutAppNotificationHistoryRow) {
  if (notification.read_at) return "read";
  if (notification.push_status.toLowerCase() === "failed") return "failed";
  if (notification.push_status.toLowerCase() === "sent") return "delivered";
  // The inbox row is already available in DropX One even when no device token
  // is configured, so it is still a successfully sent App notification.
  return "sent";
}

export function payoutAppNotificationCampaigns(
  batches: PayoutAppNotificationCampaignRow[]
): Campaign[] {
  return batches.map((batch) => {
    const notifications = [...(batch.mob_app_notifications ?? [])]
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    const campaignRecipients: CampaignRecipient[] = notifications.map((notification, index) => {
      const snapshotDropxId = typeof notification.data?.dropxId === "string"
        ? notification.data.dropxId.trim()
        : "";
      const snapshotName = typeof notification.data?.dropxName === "string"
        ? notification.data.dropxName.trim()
        : "";
      return {
        id: notification.id,
        row_no: index + 1,
        recipient_name: snapshotName || "Payout recipient",
        recipient_mobile: snapshotDropxId || notification.recipient_account_id,
        country_code: null,
        status: recipientStatus(notification),
        provider_message_id: null,
        error_message: notification.push_error,
        sent_at: notification.created_at,
        updated_at: notification.read_at ?? notification.created_at
      };
    });
    const failedCount = campaignRecipients.filter((recipient) => recipient.status === "failed").length;
    const pendingCount = notifications.filter((notification) =>
      !notification.read_at
      && notification.push_status.toLowerCase() === "pending"
      && !/^no active .*device token\.?$/i.test(notification.push_error?.trim() ?? "")
    ).length;

    return {
      id: batch.id,
      campaign_code: batch.campaign_code,
      channel: "App",
      whatsapp_profile_id: null,
      whatsapp_profile_name: "DropX One",
      created_at: batch.created_at,
      total_count: campaignRecipients.length,
      sent_count: campaignRecipients.filter((recipient) => recipient.status === "sent").length,
      failed_count: failedCount,
      pending_count: pendingCount,
      status: pendingCount > 0 ? "processing" : failedCount === campaignRecipients.length && failedCount > 0 ? "failed" : "completed",
      whatsapp_campaign_recipients: campaignRecipients
    };
  });
}
