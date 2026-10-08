import { AppShell } from "@/components/app-shell";
import { NotificationHistoryPanel } from "@/components/notification-history-panel";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { Campaign } from "@/components/campaign-report";
import {
  payoutAppNotificationCampaigns,
  type PayoutAppNotificationCampaignRow
} from "@/lib/payout-app-notification-history";
import {
  payoutWhatsappNotificationCampaigns,
  type PayoutWhatsappMessageLogHistoryRow,
  type PayoutWhatsappPublicationHistoryRow
} from "@/lib/payout-whatsapp-notification-history";

export const dynamic = "force-dynamic";

type CampaignRow = Omit<Campaign, "channel">;

async function loadNotificationHistory(companyId: string) {
  if (!supabaseAdmin) {
    return {
      campaignError: "Supabase service role key is not configured.",
      campaigns: [] as Campaign[]
    };
  }

  const [campaignProfiles, campaigns, appCampaigns, payoutPublications, payoutMessageLogs] = await Promise.all([
    supabaseAdmin.from("whatsapp_profiles").select("id, profile_name").eq("company_id", companyId),
    supabaseAdmin
      .from("whatsapp_campaigns")
      .select("id, campaign_code, whatsapp_profile_id, whatsapp_profile_name, created_at, total_count, sent_count, failed_count, pending_count, status, whatsapp_campaign_recipients (id, row_no, recipient_name, recipient_mobile, country_code, status, provider_message_id, error_message, sent_at, updated_at)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("mob_app_notification_campaigns")
      .select("id, campaign_code, created_at, mob_app_notifications!mob_app_notifications_campaign_id_fkey (id, recipient_profile_type, recipient_account_id, title, body, data, created_at, read_at, push_status, push_error)")
      .eq("company_id", companyId)
      .eq("event_code", "workforce_payout_review")
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("workforce_payout_publications")
      .select("id, workforce_id, station_id, published_by, published_at, period_start, period_end, notification_status, notification_error, notification_reference, notification_attempted_at, notification_config_snapshot")
      .eq("company_id", companyId)
      .eq("publication_kind", "worksheet")
      .order("published_at", { ascending: false })
      .limit(1000),
    supabaseAdmin
      .from("whatsapp_message_logs")
      .select("id, status, provider_message_id, error_message, request_payload, created_at")
      .eq("company_id", companyId)
      .eq("event_code", "workforce_payout_review")
      .order("created_at", { ascending: false })
      .limit(1000)
  ]);

  const appRows = (appCampaigns.data ?? []) as unknown as PayoutAppNotificationCampaignRow[];
  const payoutPublicationRows = (payoutPublications.data ?? []) as unknown as PayoutWhatsappPublicationHistoryRow[];
  const payoutMessageLogRows = (payoutMessageLogs.data ?? []) as unknown as PayoutWhatsappMessageLogHistoryRow[];

  const profileNameById = new Map(((campaignProfiles.data ?? []) as Array<{ id: string; profile_name: string }>).map((profile) => [profile.id, profile.profile_name]));
  const campaignSetupMissing = campaigns.error?.message?.includes("whatsapp_campaigns") || campaigns.error?.message?.includes("whatsapp_campaign_recipients");
  const appCampaignSetupMissing = appCampaigns.error?.message?.includes("mob_app_notification_campaigns")
    || appCampaigns.error?.message?.includes("mob_app_notifications_campaign_id_fkey");
  const campaignError = campaignProfiles.error?.message
    ?? (campaignSetupMissing ? `${campaigns.error?.message} Run scripts/whatsapp_campaigns_v1.sql in Supabase SQL Editor.` : campaigns.error?.message)
    ?? (appCampaignSetupMissing ? `${appCampaigns.error?.message} Apply the Workforce payout App notification history migration.` : appCampaigns.error?.message)
    ?? payoutPublications.error?.message
    ?? payoutMessageLogs.error?.message
    ?? null;

  const whatsappCampaigns = ((campaigns.data ?? []) as CampaignRow[]).map((campaign) => ({
    ...campaign,
    channel: "WhatsApp",
    whatsapp_profile_name: campaign.whatsapp_profile_id ? profileNameById.get(campaign.whatsapp_profile_id) ?? campaign.whatsapp_profile_name : campaign.whatsapp_profile_name,
    whatsapp_campaign_recipients: [...(campaign.whatsapp_campaign_recipients ?? [])].sort((left, right) => left.row_no - right.row_no)
  }));
  const payoutAppCampaigns = payoutAppNotificationCampaigns(appRows);
  const payoutWhatsappCampaigns = payoutWhatsappNotificationCampaigns(
    payoutPublicationRows,
    payoutMessageLogRows,
    profileNameById
  );

  return {
    campaignError,
    campaigns: [...whatsappCampaigns, ...payoutWhatsappCampaigns, ...payoutAppCampaigns]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
  };
}

export default async function NotificationHistoryPage() {
  const authorization = await requirePagePermission("notifications_history", "access");
  const data = await loadNotificationHistory(requireCompanyId(authorization));

  return (
    <AppShell active="History" pageCode="notifications_history">
      <NotificationHistoryPanel campaignError={data.campaignError} campaigns={data.campaigns} />
    </AppShell>
  );
}
