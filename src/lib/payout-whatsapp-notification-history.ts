import type { Campaign, CampaignRecipient } from "@/components/campaign-report";

export type PayoutWhatsappPublicationHistoryRow = {
  id: string;
  workforce_id: string;
  station_id: string | null;
  published_by: string | null;
  published_at: string;
  period_start: string | null;
  period_end: string | null;
  notification_status: string;
  notification_error: string | null;
  notification_reference: string | null;
  notification_attempted_at: string | null;
  notification_config_snapshot: Record<string, unknown> | null;
};

export type PayoutWhatsappMessageLogHistoryRow = {
  id: string;
  status: string;
  provider_message_id: string | null;
  error_message: string | null;
  request_payload: Record<string, unknown> | null;
  created_at: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function hasWhatsappNotification(publication: PayoutWhatsappPublicationHistoryRow) {
  const config = record(publication.notification_config_snapshot);
  if (!config) return false;
  if (typeof config.whatsapp_notification_enabled === "boolean") {
    return config.whatsapp_notification_enabled;
  }
  // Publications created before the App-notification toggle was introduced
  // do not have channel booleans. Their frozen WhatsApp setup is authoritative.
  return Boolean(text(config.whatsapp_profile_id) && text(config.recipient));
}

function publicationBatchKey(publication: PayoutWhatsappPublicationHistoryRow) {
  return [
    publication.published_at,
    publication.published_by ?? "system",
    publication.period_start ?? "",
    publication.period_end ?? ""
  ].join("|");
}

function notificationPrimary(
  current: PayoutWhatsappPublicationHistoryRow | undefined,
  candidate: PayoutWhatsappPublicationHistoryRow
) {
  if (!current) return candidate;
  // The publication route intentionally chooses the lexicographically first
  // station as the one notification row for a multi-location Workforce ID.
  const currentStation = current.station_id ?? "";
  const candidateStation = candidate.station_id ?? "";
  return candidateStation.localeCompare(currentStation) < 0 ? candidate : current;
}

function recipientStatus(
  publication: PayoutWhatsappPublicationHistoryRow,
  messageLog?: PayoutWhatsappMessageLogHistoryRow
) {
  const logged = text(messageLog?.status).toLowerCase();
  if (["sent", "delivered", "read", "failed"].includes(logged)) return logged;

  const status = text(publication.notification_status).toLowerCase();
  if (status === "sent") return "sent";
  if (status === "failed") return "failed";
  if (status === "superseded") {
    if (publication.notification_reference) return "sent";
    if (publication.notification_error) return "failed";
    return "skipped";
  }
  if (status === "sending" || status === "uncertain") return "processing";
  return "pending";
}

function campaignStatus(recipients: CampaignRecipient[]) {
  const statuses = recipients.map((recipient) => recipient.status.toLowerCase());
  if (statuses.some((status) => status === "pending" || status === "processing")) return "processing";
  if (statuses.length > 0 && statuses.every((status) => status === "failed")) return "failed";
  return "completed";
}

export function payoutWhatsappNotificationCampaigns(
  publications: PayoutWhatsappPublicationHistoryRow[],
  messageLogs: PayoutWhatsappMessageLogHistoryRow[],
  profileNameById: ReadonlyMap<string, string> = new Map()
): Campaign[] {
  const logsByPublicationId = new Map<string, PayoutWhatsappMessageLogHistoryRow>();
  for (const log of messageLogs) {
    const publicationId = text(record(log.request_payload)?.publication_id);
    if (!publicationId) continue;
    const current = logsByPublicationId.get(publicationId);
    if (!current || log.created_at.localeCompare(current.created_at) > 0) {
      logsByPublicationId.set(publicationId, log);
    }
  }

  const batches = new Map<string, PayoutWhatsappPublicationHistoryRow[]>();
  for (const publication of publications) {
    if (!hasWhatsappNotification(publication)) continue;
    const key = publicationBatchKey(publication);
    batches.set(key, [...(batches.get(key) ?? []), publication]);
  }

  return [...batches.values()].map((batch) => {
    const primaryByWorkforce = new Map<string, PayoutWhatsappPublicationHistoryRow>();
    for (const publication of batch) {
      primaryByWorkforce.set(
        publication.workforce_id,
        notificationPrimary(primaryByWorkforce.get(publication.workforce_id), publication)
      );
    }
    const primaryRows = [...primaryByWorkforce.values()]
      .sort((left, right) => left.id.localeCompare(right.id));
    const first = primaryRows[0];
    const firstConfig = record(first.notification_config_snapshot) ?? {};
    const recipients = primaryRows.map((publication, index): CampaignRecipient => {
      const config = record(publication.notification_config_snapshot) ?? {};
      const values = record(config.resolved_values) ?? {};
      const messageLog = logsByPublicationId.get(publication.id);
      return {
        id: messageLog?.id ?? publication.id,
        row_no: index + 1,
        recipient_name: text(values.full_name) || "Workforce account",
        recipient_mobile: text(config.recipient) || text(values.dropx_id) || publication.workforce_id,
        country_code: null,
        status: recipientStatus(publication, messageLog),
        provider_message_id: messageLog?.provider_message_id ?? publication.notification_reference,
        error_message: messageLog?.error_message ?? publication.notification_error,
        sent_at: messageLog?.created_at ?? publication.notification_attempted_at ?? publication.published_at,
        updated_at: messageLog?.created_at ?? publication.notification_attempted_at ?? publication.published_at
      };
    });
    const failedCount = recipients.filter((recipient) => recipient.status === "failed").length;
    const pendingCount = recipients.filter((recipient) => ["pending", "processing"].includes(recipient.status)).length;
    const profileId = text(firstConfig.whatsapp_profile_id) || null;

    return {
      id: `payout-whatsapp:${first.id}`,
      campaign_code: `PAYOUT-WA-${first.id.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      channel: "WhatsApp",
      whatsapp_profile_id: profileId,
      whatsapp_profile_name: profileId ? profileNameById.get(profileId) ?? "WhatsApp" : "WhatsApp",
      created_at: first.published_at,
      total_count: recipients.length,
      sent_count: recipients.filter((recipient) => recipient.status === "sent").length,
      failed_count: failedCount,
      pending_count: pendingCount,
      status: campaignStatus(recipients),
      whatsapp_campaign_recipients: recipients
    };
  }).sort((left, right) => right.created_at.localeCompare(left.created_at));
}
