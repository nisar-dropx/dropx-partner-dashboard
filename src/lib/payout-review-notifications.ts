import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WhatsAppTemplateComponent } from "@/lib/whatsapp-template";
import {
  buildWorkforcePayoutTemplateComponents,
  normalizeWorkforceWhatsAppRecipient,
  workforcePayoutWhatsAppValues,
  WORKFORCE_PAYOUT_WHATSAPP_EVENT,
  WORKFORCE_PAYOUT_WHATSAPP_FIELDS,
  type WorkforcePayoutWhatsAppValues
} from "@/lib/workforce-payout-whatsapp";

const PUBLICATION_COLUMNS = "id,company_id,workforce_id,payroll_run_id,source_calculated_at,snapshot,review_until,period_start,period_end,notify_at,notification_config_snapshot,publication_kind";

type PayoutPublication = {
  id: string;
  company_id: string;
  workforce_id: string;
  payroll_run_id: string | null;
  source_calculated_at: string | null;
  snapshot: Record<string, unknown>;
  review_until: string;
  period_start?: string | null;
  period_end?: string | null;
  notify_at: string;
  notification_config_snapshot: unknown;
  publication_kind: "legacy_payroll" | "worksheet";
};

type NotificationConfig = {
  whatsapp_profile_id: string;
  template_id: string;
  template_name: string;
  template_language: string;
  variable_mappings: Record<string, string>;
  template_components?: WhatsAppTemplateComponent[];
  resolved_values?: WorkforcePayoutWhatsAppValues;
  recipient?: string;
};

export type ProcessPayoutReviewNotificationOptions = {
  publicationIds?: string[];
  batchSize?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function frozenNotificationConfig(value: unknown): NotificationConfig {
  const frozen = record(value);
  if (!frozen || frozen.schema_version !== 1 || frozen.event_code !== WORKFORCE_PAYOUT_WHATSAPP_EVENT) {
    throw new Error("The published payout notification configuration is invalid.");
  }
  const mappingsRow = record(frozen.variable_mappings);
  const valuesRow = record(frozen.resolved_values);
  if (!mappingsRow || !valuesRow || !Array.isArray(frozen.template_components)) {
    throw new Error("The published payout notification configuration is incomplete.");
  }
  const config = {
    whatsapp_profile_id: String(frozen.whatsapp_profile_id ?? "").trim(),
    template_id: String(frozen.template_id ?? "").trim(),
    template_name: String(frozen.template_name ?? "").trim(),
    template_language: String(frozen.template_language ?? "").trim(),
    recipient: String(frozen.recipient ?? "").trim(),
    variable_mappings: Object.fromEntries(Object.entries(mappingsRow).map(([key, source]) => [key, String(source ?? "").trim()])),
    template_components: frozen.template_components as WhatsAppTemplateComponent[],
    resolved_values: Object.fromEntries(WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => {
      if (typeof valuesRow[field.value] !== "string") {
        throw new Error(`The published payout value ${field.value} is invalid.`);
      }
      return [field.value, valuesRow[field.value]];
    })) as WorkforcePayoutWhatsAppValues
  };
  if (!config.whatsapp_profile_id || !config.template_id || !config.template_name || !config.template_language || !/^\d{11,15}$/.test(config.recipient)) {
    throw new Error("The published payout notification configuration is incomplete.");
  }
  return config;
}

function legacyNotificationConfig(value: unknown): NotificationConfig {
  const config = record(value);
  if (!config?.is_enabled) throw new Error("Workforce payout WhatsApp notifications are disabled.");
  const normalized = {
    whatsapp_profile_id: String(config.whatsapp_profile_id ?? "").trim(),
    template_id: String(config.template_id ?? "").trim(),
    template_name: String(config.template_name ?? "").trim(),
    template_language: String(config.template_language ?? "").trim(),
    variable_mappings: Object.fromEntries(Object.entries(record(config.variable_mappings) ?? {}).map(([key, source]) => [key, String(source ?? "").trim()]))
  };
  if (!normalized.whatsapp_profile_id || !normalized.template_id || !normalized.template_name || !normalized.template_language) {
    throw new Error("Workforce payout WhatsApp configuration is incomplete.");
  }
  return normalized;
}

function boundedNumber(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value!)));
}

async function concurrently<T>(rows: T[], concurrency: number, run: (row: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next;
      next += 1;
      await run(rows[index]);
    }
  }));
}

export async function processPayoutReviewNotifications(options: ProcessPayoutReviewNotificationOptions = {}) {
  const errors: string[] = [];
  const db = supabaseAdmin;
  if (!db) return { processed: 0, sent: 0, errors: ["Database unavailable"] };
  const publicationIds = [...new Set((options.publicationIds ?? []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 1000);
  const targeted = publicationIds.length > 0;

  // Cron recovery only. A targeted post-publish run must not repeatedly scan or
  // mutate unrelated publications.
  if (!targeted) {
    await db
      .from("workforce_payout_publications")
      .update({ notification_status: "uncertain", notification_error: "Delivery outcome needs operator verification." })
      .eq("notification_status", "sending")
      .lt("notification_attempted_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  }

  const batchSize = boundedNumber(options.batchSize, targeted ? publicationIds.length : 50, targeted ? 1000 : 200);
  const now = new Date().toISOString();
  const queueRows: PayoutPublication[] = [];
  if (targeted) {
    for (let offset = 0; offset < publicationIds.length && queueRows.length < batchSize; offset += 100) {
      const chunk = publicationIds.slice(offset, offset + 100);
      const result = await db
        .from("workforce_payout_publications")
        .select(PUBLICATION_COLUMNS)
        .in("id", chunk)
        .eq("notification_status", "pending")
        .lte("notify_at", now);
      if (result.error) return { processed: 0, sent: 0, errors: ["Payout notification queue unavailable"] };
      queueRows.push(...(result.data ?? []) as PayoutPublication[]);
    }
    queueRows.sort((left, right) => left.notify_at.localeCompare(right.notify_at));
  } else {
    const result = await db
      .from("workforce_payout_publications")
      .select(PUBLICATION_COLUMNS)
      .eq("notification_status", "pending")
      .lte("notify_at", now)
      .order("notify_at")
      .limit(batchSize);
    if (result.error) return { processed: 0, sent: 0, errors: ["Payout notification queue unavailable"] };
    queueRows.push(...(result.data ?? []) as PayoutPublication[]);
  }
  const queue = queueRows.slice(0, batchSize);

  let processed = 0;
  let sent = 0;
  await concurrently(queue, targeted ? 12 : 8, async (publication) => {
    const claim = await db
      .from("workforce_payout_publications")
      .update({ notification_status: "sending", notification_attempted_at: new Date().toISOString() })
      .eq("id", publication.id)
      .eq("notification_status", "pending")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) return;
    processed += 1;

    let attempted = false;
    try {
      // Legacy publications point at a mutable payroll run and retain the old
      // drift guard. Schema-v2 publications carry an immutable snapshot and may
      // intentionally have no payroll_run_id.
      if (publication.payroll_run_id && publication.source_calculated_at) {
        const run = await db
          .from("workforce_payroll_runs")
          .select("status,calculated_at")
          .eq("id", publication.payroll_run_id)
          .eq("company_id", publication.company_id)
          .single();
        if (run.error) throw new Error("Payout state unavailable.");
        if (run.data.status !== "review" || run.data.calculated_at !== publication.source_calculated_at) {
          await db.from("workforce_payout_publications").update({ notification_status: "superseded" }).eq("id", publication.id);
          return;
        }
      }
      if (new Date(publication.review_until).getTime() <= Date.now()) {
        throw new Error("The review window has ended. Publish a revised review window before notifying.");
      }

      const frozenRow = record(publication.notification_config_snapshot);
      const hasFrozenConfig = publication.publication_kind === "worksheet" || frozenRow?.schema_version === 1;
      const frozenConfig = hasFrozenConfig ? frozenNotificationConfig(publication.notification_config_snapshot) : null;
      const [settingsResult, personResult, legacyConfigResult] = await Promise.all([
        db.from("whatsapp_settings").select("is_enabled").eq("company_id", publication.company_id).eq("id", true).maybeSingle(),
        db
          .from("workforce")
          .select("mobile,mobile_country_code,full_name,dropx_id")
          .eq("company_id", publication.company_id)
          .eq("id", publication.workforce_id)
          .single(),
        frozenConfig
          ? Promise.resolve({ data: null, error: null })
          : db
            .from("whatsapp_notification_configs")
            .select("is_enabled,whatsapp_profile_id,template_id,template_name,template_language,variable_mappings")
            .eq("company_id", publication.company_id)
            .eq("event_code", WORKFORCE_PAYOUT_WHATSAPP_EVENT)
            .maybeSingle()
      ]);
      if (settingsResult.error || !settingsResult.data?.is_enabled) throw new Error("WhatsApp messaging is disabled.");
      if (personResult.error) throw new Error("The workforce notification recipient is unavailable.");
      if (legacyConfigResult.error) throw new Error("Workforce payout WhatsApp configuration is unavailable.");
      const config = frozenConfig ?? legacyNotificationConfig(legacyConfigResult.data);

      const [profileResult, tokenResult, templateResult] = await Promise.all([
        db
          .from("whatsapp_profiles")
          .select("id,profile_name,phone_number_id,graph_api_version,default_country_code,is_active")
          .eq("company_id", publication.company_id)
          .eq("id", config.whatsapp_profile_id)
          .maybeSingle(),
        db.rpc("get_whatsapp_profile_access_token", { profile_id: config.whatsapp_profile_id }),
        db
          .from("whatsapp_template_cache")
          .select("template_id,whatsapp_profile_id,name,language,status,components")
          .eq("company_id", publication.company_id)
          .eq("template_id", config.template_id)
          .eq("whatsapp_profile_id", config.whatsapp_profile_id)
          .maybeSingle()
      ]);
      if (profileResult.error || !profileResult.data?.is_active || !profileResult.data.phone_number_id || !profileResult.data.graph_api_version) {
        throw new Error("The configured WhatsApp sender is incomplete or inactive.");
      }
      if (tokenResult.error || !tokenResult.data) throw new Error("The configured WhatsApp sender token is unavailable.");
      if (templateResult.error || !templateResult.data || templateResult.data.status !== "APPROVED") {
        throw new Error("The configured payout template is no longer approved. Sync templates and review the setting.");
      }
      if (templateResult.data.name !== config.template_name || templateResult.data.language !== config.template_language) {
        throw new Error("The configured payout template changed. Review and publish the payout again.");
      }
      if (config.template_components && JSON.stringify(templateResult.data.components ?? []) !== JSON.stringify(config.template_components)) {
        throw new Error("The approved payout template content changed. Sync settings and publish the payout again.");
      }

      const values = config.resolved_values ?? workforcePayoutWhatsAppValues({
        snapshot: publication.snapshot as Parameters<typeof workforcePayoutWhatsAppValues>[0]["snapshot"],
        person: personResult.data,
        reviewUntil: publication.review_until
      });
      const components = config.template_components ?? (templateResult.data.components ?? []) as WhatsAppTemplateComponent[];
      const messageComponents = buildWorkforcePayoutTemplateComponents(components, config.variable_mappings, values);
      const recipient = config.recipient ?? normalizeWorkforceWhatsAppRecipient(
        personResult.data.mobile,
        personResult.data.mobile_country_code || profileResult.data.default_country_code
      );
      if (!recipient) throw new Error("Associate mobile number is invalid.");
      const requestPayload = {
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        template: {
          name: config.template_name,
          language: { code: config.template_language },
          components: messageComponents
        }
      };

      attempted = true;
      const response = await fetch(
        `https://graph.facebook.com/${profileResult.data.graph_api_version}/${profileResult.data.phone_number_id}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenResult.data}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: AbortSignal.timeout(20_000)
        }
      );
      const responsePayload = await response.json().catch(() => ({})) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string };
      };
      if (!response.ok) {
        // Meta gave a definite rejection, so an operator may safely retry after
        // fixing configuration. Transport ambiguity remains "uncertain".
        attempted = false;
        throw new Error(responsePayload.error?.message || "WhatsApp rejected this notification. Check the approved sending configuration.");
      }
      const reference = responsePayload.messages?.[0]?.id;
      if (!reference) throw new Error("WhatsApp did not return a message receipt.");

      const saved = await db
        .from("workforce_payout_publications")
        .update({ notification_status: "sent", notification_reference: reference, notification_error: null })
        .eq("id", publication.id)
        .eq("notification_status", "sending");
      if (saved.error) throw new Error("Message receipt could not be saved.");

      const messageLog = await db.from("whatsapp_message_logs").insert({
        company_id: publication.company_id,
        event_code: WORKFORCE_PAYOUT_WHATSAPP_EVENT,
        workforce_id: publication.workforce_id,
        whatsapp_profile_id: profileResult.data.id,
        whatsapp_profile_name: profileResult.data.profile_name,
        recipient,
        template_name: config.template_name,
        status: "sent",
        provider_message_id: reference,
        request_payload: {
          publication_id: publication.id,
          workforce_id: publication.workforce_id,
          template_id: config.template_id,
          variable_mappings: config.variable_mappings,
          values,
          request: requestPayload
        },
        response_payload: responsePayload
      });
      if (messageLog.error) {
        const logError = `Payout notification ${publication.id} was accepted by WhatsApp, but its message audit log could not be saved: ${messageLog.error.message}`;
        console.error(logError);
        errors.push(logError);
      }
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification failed";
      await db
        .from("workforce_payout_publications")
        .update({ notification_status: attempted ? "uncertain" : "failed", notification_error: message })
        .eq("id", publication.id)
        .eq("notification_status", "sending");
      errors.push(`Payout notification ${publication.id}: ${message}`);
    }
  });
  return { processed, sent, errors };
}
