import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { WORKFORCE_PAYOUT_WHATSAPP_EVENT } from "@/lib/workforce-payout-whatsapp";
import {
  WorkforcePayoutNotificationForm,
  type PayoutNotificationConfig,
  type PayoutNotificationProfile,
  type PayoutNotificationTemplate
} from "./payout-notification-form";

export const dynamic = "force-dynamic";

function loadFlash() {
  const raw = cookies().get("dropx_workforce_payout_whatsapp_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadConfiguration(companyId: string) {
  if (!supabaseAdmin) return { error: "Supabase service role key is not configured." };
  const [settingsResult, profileResult, templateResult, configResult] = await Promise.all([
    supabaseAdmin.from("whatsapp_settings").select("is_enabled").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin
      .from("whatsapp_profiles")
      .select("id,profile_name,is_default,default_country_code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("profile_name"),
    supabaseAdmin
      .from("whatsapp_template_cache")
      .select("template_id,whatsapp_profile_id,name,language,category,status,components,synced_at")
      .eq("company_id", companyId)
      .eq("status", "APPROVED")
      .order("name"),
    supabaseAdmin
      .from("whatsapp_notification_configs")
      .select("app_notification_enabled,is_enabled,whatsapp_profile_id,template_id,template_name,template_language,variable_mappings")
      .eq("company_id", companyId)
      .eq("event_code", WORKFORCE_PAYOUT_WHATSAPP_EVENT)
      .maybeSingle()
  ]);
  const error = settingsResult.error ?? profileResult.error ?? templateResult.error ?? configResult.error;
  if (error) return { error: error.message };
  const config = configResult.data;
  return {
    error: null as string | null,
    globalWhatsAppEnabled: Boolean(settingsResult.data?.is_enabled),
    profiles: (profileResult.data ?? []) as PayoutNotificationProfile[],
    templates: (templateResult.data ?? []) as PayoutNotificationTemplate[],
    config: {
      app_notification_enabled: Boolean(config?.app_notification_enabled),
      is_enabled: Boolean(config?.is_enabled),
      whatsapp_profile_id: config?.whatsapp_profile_id ?? null,
      template_id: config?.template_id ?? null,
      template_name: config?.template_name ?? null,
      template_language: config?.template_language ?? null,
      variable_mappings: (config?.variable_mappings ?? {}) as Record<string, string>
    } satisfies PayoutNotificationConfig
  };
}

export default async function WorkforcePayoutNotificationSettingsPage() {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, "payment_settings", "edit");
  const data = await loadConfiguration(companyId);
  const flash = loadFlash();

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Payout Notifications"
        subtitle="Configure WhatsApp and DropX One App notifications for frozen Workforce and Helper payout details."
        action={(
          <span className="listing-head-actions">
            <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>
              {isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}
            </span>
            <PendingLink className="button secondary" href="/settings/workforce-payment">Back</PendingLink>
          </span>
        )}
      />

      {data.error ? (
        <section aria-live="assertive" className="panel message-panel error" role="alert">
          <div className="panel-body">
            <strong>Payout notification settings are unavailable</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error}</p>
          </div>
        </section>
      ) : null}

      {!data.error && (flash.error || flash.notice) ? (
        <section aria-live={flash.error ? "assertive" : "polite"} className={`panel message-panel ${flash.error ? "error" : "success"}`} role={flash.error ? "alert" : "status"}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!data.error && data.config ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Notification configuration</h2>
              <p className="subtle">The same configuration is used when a Workforce or Helper payout is published. App notifications open the exact payout month in DropX One; WhatsApp uses the approved template and sender below.</p>
            </div>
          </div>
          <WorkforcePayoutNotificationForm
            canEdit={canEdit}
            config={data.config}
            globalWhatsAppEnabled={Boolean(data.globalWhatsAppEnabled)}
            profiles={data.profiles ?? []}
            templates={data.templates ?? []}
          />
        </section>
      ) : null}
    </AppShell>
  );
}
