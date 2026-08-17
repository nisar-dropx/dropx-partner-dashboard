import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { MetaChannelProfilesPanel, type MetaChannelProfile } from "@/components/meta-channel-profiles-panel";
import { MetaMessagingSettingsPanel } from "@/components/meta-messaging-settings-panel";
import { PageHead } from "@/components/page-head";
import { WhatsAppSettingsPanel, type NotificationConfig, type WhatsAppOnboardingTarget } from "@/components/whatsapp-settings-panel";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WhatsAppTemplateComponent } from "@/lib/whatsapp-template";
import { workforceOnboardingEventCode } from "@/lib/whatsapp-onboarding";

export const dynamic = "force-dynamic";

function loadFlash() {
  const raw = cookies().get("dropx_meta_messaging_settings_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return { error: typeof parsed.error === "string" ? parsed.error : null, notice: typeof parsed.notice === "string" ? parsed.notice : null };
  } catch {
    return { error: null, notice: null };
  }
}

function loadWhatsAppFlash() {
  const raw = cookies().get("dropx_whatsapp_settings_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return { error: typeof parsed.error === "string" ? parsed.error : null, notice: typeof parsed.notice === "string" ? parsed.notice : null };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadMetaMessagingSettings(companyId: string) {
  const defaults = {
    is_facebook_enabled: false,
    is_instagram_enabled: false,
    meta_app_id: "",
    graph_api_version: "v25.0",
    webhook_verify_token: "",
    facebook_page_id: "",
    facebook_page_name: "",
    instagram_business_account_id: "",
    instagram_connected_page_id: "",
    app_secret_configured: false,
    page_access_token_configured: false,
    app_secret_mask: "",
    page_access_token_mask: ""
  };
  if (!supabaseAdmin) return { settings: defaults, error: "Supabase service role key is not configured." };

  const result = await supabaseAdmin
    .from("meta_messaging_settings")
    .select("is_facebook_enabled, is_instagram_enabled, meta_app_id, graph_api_version, webhook_verify_token, facebook_page_id, facebook_page_name, instagram_business_account_id, instagram_connected_page_id, app_secret_secret_id, page_access_token_secret_id")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();

  if (result.error) return { settings: defaults, error: result.error.message };
  const row = result.data;

  const maskSecret = (configured: boolean) => (configured ? "********************************" : "");

  return {
    settings: {
      is_facebook_enabled: Boolean(row?.is_facebook_enabled),
      is_instagram_enabled: Boolean(row?.is_instagram_enabled),
      meta_app_id: row?.meta_app_id ?? "",
      graph_api_version: row?.graph_api_version ?? "v25.0",
      webhook_verify_token: row?.webhook_verify_token ?? "",
      facebook_page_id: row?.facebook_page_id ?? "",
      facebook_page_name: row?.facebook_page_name ?? "",
      instagram_business_account_id: row?.instagram_business_account_id ?? "",
      instagram_connected_page_id: row?.instagram_connected_page_id ?? "",
      app_secret_configured: Boolean(row?.app_secret_secret_id),
      page_access_token_configured: Boolean(row?.page_access_token_secret_id),
      app_secret_mask: maskSecret(Boolean(row?.app_secret_secret_id)),
      page_access_token_mask: maskSecret(Boolean(row?.page_access_token_secret_id))
    },
    error: null as string | null
  };
}

async function loadWhatsAppSettings(companyId: string) {
  const emptyConfig: NotificationConfig = { is_enabled: false, template_id: null, whatsapp_profile_id: null, variable_mappings: {} };
  const defaults = {
    general: { is_enabled: false, webhook_verify_token: null as string | null },
    profiles: [] as Array<{ id: string; profile_name: string; business_account_id: string | null; phone_number_id: string; graph_api_version: string; default_country_code: string; chat_enabled: boolean; greeting_enabled: boolean; greeting_message: string | null; is_active: boolean; is_default: boolean; token_configured: boolean; token_mask: string; usage_count: number }>,
    onboardingTargets: [] as WhatsAppOnboardingTarget[],
    otpConfig: { is_enabled: false, template_id: null as string | null, whatsapp_profile_id: null as string | null, variable_mappings: {} as Record<string, string> },
    templates: [] as Array<{ template_id: string; whatsapp_profile_id: string | null; name: string; language: string; category: string | null; status: string; components: WhatsAppTemplateComponent[] }>
  };
  if (!supabaseAdmin) return { ...defaults, error: "Supabase service role key is not configured." };
  const admin = supabaseAdmin;

  const [settings, profiles, categories, templates] = await Promise.all([
    admin.from("whatsapp_settings").select("is_enabled, webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle(),
    admin.from("whatsapp_profiles").select("id, profile_name, business_account_id, phone_number_id, graph_api_version, default_country_code, chat_enabled, greeting_enabled, greeting_message, is_active, is_default, token_secret_id").eq("company_id", companyId).order("profile_name"),
    admin.from("workforce_categories").select("code, name").eq("company_id", companyId).eq("is_active", true).order("sort_order").order("name"),
    admin.from("whatsapp_template_cache").select("template_id, whatsapp_profile_id, name, language, category, status, components").eq("company_id", companyId).order("name")
  ]);
  const fallbackCategories = [
    { code: "employees", name: "Employees" },
    { code: "contractors", name: "Independent Contractors" },
    { code: "vendors", name: "Vendors" },
    { code: "workers", name: "Workers" }
  ];
  const categoryRows = categories.error ? fallbackCategories : (categories.data ?? []);
  const onboardingCategories = categoryRows.map((category) => ({
    categoryCode: category.code,
    code: workforceOnboardingEventCode(category.code),
    label: category.name
  }));
  const eventCodes = [...onboardingCategories.map((category) => category.code), "onboarding_otp_verification"];
  const configs = await admin
    .from("whatsapp_notification_configs")
    .select("event_code, is_enabled, template_id, whatsapp_profile_id, variable_mappings")
    .eq("company_id", companyId)
    .in("event_code", eventCodes);
  const error = settings.error?.message || profiles.error?.message || configs.error?.message || templates.error?.message || null;
  const profileRows = await Promise.all(((profiles.data ?? []) as Array<{ id: string; profile_name: string; business_account_id: string | null; phone_number_id: string; graph_api_version: string; default_country_code: string; chat_enabled: boolean; greeting_enabled: boolean; greeting_message: string | null; is_active: boolean; is_default: boolean; token_secret_id: string | null }>).map(async (profile) => {
    const tokenMask = profile.token_secret_id ? "********************************" : "";
    const [configUsage, campaignUsage] = await Promise.all([
      admin.from("whatsapp_notification_configs").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("whatsapp_profile_id", profile.id),
      admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("whatsapp_profile_id", profile.id)
    ]);
    return {
      ...profile,
      token_configured: Boolean(profile.token_secret_id),
      token_mask: tokenMask,
      usage_count: (configUsage.count ?? 0) + (campaignUsage.count ?? 0)
    };
  }));
  const configRows = (configs.data ?? []) as Array<{ event_code: string; is_enabled: boolean; template_id: string | null; whatsapp_profile_id: string | null; variable_mappings: Record<string, string> | null }>;
  const configByEvent = new Map(configRows.map((row) => [row.event_code, {
    is_enabled: Boolean(row.is_enabled),
    template_id: row.template_id,
    whatsapp_profile_id: row.whatsapp_profile_id,
    variable_mappings: (row.variable_mappings ?? {}) as Record<string, string>
  }]));

  return {
    general: settings.data ?? defaults.general,
    profiles: profileRows,
    onboardingTargets: onboardingCategories.map((category) => ({
      ...category,
      config: configByEvent.get(category.code) ?? emptyConfig
    })),
    otpConfig: configByEvent.get("onboarding_otp_verification") ?? defaults.otpConfig,
    templates: (templates.data ?? []) as typeof defaults.templates,
    error
  };
}

async function loadMetaChannelProfiles(channel: "facebook" | "instagram", companyId: string) {
  if (!supabaseAdmin) return { profiles: [] as MetaChannelProfile[], error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin
    .from("meta_channel_profiles")
    .select("id, channel, profile_name, page_id, page_name, instagram_business_account_id, connected_page_id, graph_api_version, chat_enabled, is_active, is_default, access_token_secret_id")
    .eq("company_id", companyId)
    .eq("channel", channel)
    .order("profile_name");
  if (result.error) return { profiles: [] as MetaChannelProfile[], error: result.error.message };

  const profiles = await Promise.all(((result.data ?? []) as Array<{
    id: string;
    channel: "facebook" | "instagram";
    profile_name: string;
    page_id: string | null;
    page_name: string | null;
    instagram_business_account_id: string | null;
    connected_page_id: string | null;
    graph_api_version: string;
    chat_enabled: boolean;
    is_active: boolean;
    is_default: boolean;
    access_token_secret_id: string | null;
  }>).map(async (profile) => {
    const tokenMask = profile.access_token_secret_id ? "********************************" : "";
    const names = [profile.profile_name, profile.page_name].filter(Boolean);
    const usage = names.length
      ? await supabaseAdmin!
        .from("inbox_conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("channel", channel)
        .in("whatsapp_profile_name", names)
      : { count: 0, error: null };
    return {
      id: profile.id,
      channel: profile.channel,
      profile_name: profile.profile_name,
      page_id: profile.page_id,
      page_name: profile.page_name,
      instagram_business_account_id: profile.instagram_business_account_id,
      connected_page_id: profile.connected_page_id,
      graph_api_version: profile.graph_api_version,
      chat_enabled: Boolean(profile.chat_enabled),
      is_active: Boolean(profile.is_active),
      is_default: Boolean(profile.is_default),
      token_configured: Boolean(profile.access_token_secret_id),
      token_mask: tokenMask,
      usage_count: usage.count ?? 0
    };
  }));

  return { profiles, error: null as string | null };
}

export default async function MetaMessagingSettingsPage({
  searchParams
}: {
  searchParams?: { platform?: string };
}) {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.app_settings;
  const selectedPlatform = searchParams?.platform;
  const showWhatsAppDetails = selectedPlatform === "whatsapp";
  const showFacebookDetails = selectedPlatform === "facebook";
  const showInstagramDetails = selectedPlatform === "instagram";
  const [data, whatsAppData, facebookProfiles, instagramProfiles] = await Promise.all([
    loadMetaMessagingSettings(companyId),
    loadWhatsAppSettings(companyId),
    loadMetaChannelProfiles("facebook", companyId),
    loadMetaChannelProfiles("instagram", companyId)
  ]);
  const flash = loadFlash();
  const whatsAppFlash = loadWhatsAppFlash();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://dashboard.dropxlogistics.com").replace(/\/$/, "");
  const webhookUrl = `${appUrl}/api/webhooks`;
  const whatsAppSetupScript = whatsAppData.error?.includes("chat_enabled") ? "scripts/whatsapp_profile_chat_enabled_v1.sql" : whatsAppData.error?.includes("whatsapp_profiles") ? "scripts/whatsapp_profiles_v1.sql" : "scripts/whatsapp_settings_v1.sql";
  const whatsAppStatus = {
    isEnabled: Boolean(whatsAppData.general?.is_enabled),
    isConfigured: (whatsAppData.profiles ?? []).some((profile) => profile.is_active && profile.business_account_id && profile.phone_number_id && profile.token_configured)
  };
  const channelProfileError = showFacebookDetails ? facebookProfiles.error : showInstagramDetails ? instagramProfiles.error : null;

  return (
    <AppShell active="Settings" pageCode="app_settings">
      {data.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Meta messaging database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error} Run scripts/meta_messaging_settings_v1.sql in Supabase SQL Editor.</p>
          </div>
        </section>
      ) : null}
      {whatsAppData.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>WhatsApp database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{whatsAppData.error} Run {whatsAppSetupScript} in Supabase SQL Editor.</p>
          </div>
        </section>
      ) : null}
      {channelProfileError ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Meta profile database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{channelProfileError} Run scripts/meta_channel_profiles_v1.sql in Supabase SQL Editor.</p>
          </div>
        </section>
      ) : null}
      {!data.error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}
      {!whatsAppData.error && (whatsAppFlash.error || whatsAppFlash.notice) ? (
        <section className={`panel message-panel ${whatsAppFlash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{whatsAppFlash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{whatsAppFlash.error ?? whatsAppFlash.notice}</p>
          </div>
        </section>
      ) : null}
      {showWhatsAppDetails ? (
        <PageHead
          eyebrow="Configuration"
          title="WhatsApp"
          subtitle="Configure WhatsApp profiles, synced templates, notification messages, and onboarding messages."
          action={<a className="button secondary" href="/settings/meta">Back</a>}
        />
      ) : null}
      {showFacebookDetails ? (
        <PageHead
          eyebrow="Configuration"
          title="Pages / Messenger"
          subtitle="Configure multiple Facebook Page profiles for Messenger inbox."
          action={<a className="button secondary" href="/settings/meta">Back</a>}
        />
      ) : null}
      {showInstagramDetails ? (
        <PageHead
          eyebrow="Configuration"
          title="Instagram"
          subtitle="Configure multiple Instagram business profiles for DM inbox."
          action={<a className="button secondary" href="/settings/meta">Back</a>}
        />
      ) : null}
      {!data.error && !showWhatsAppDetails && !showFacebookDetails && !showInstagramDetails ? (
        <MetaMessagingSettingsPanel
          canEdit={permission.canEdit || permission.canAdd}
          settings={data.settings}
          showWhatsAppCard
          whatsAppStatus={whatsAppStatus}
        />
      ) : null}
      {showWhatsAppDetails && !whatsAppData.error ? (
        <WhatsAppSettingsPanel
          canEdit={permission.canEdit || permission.canAdd}
          commonWebhookMode
          onboardingTargets={whatsAppData.onboardingTargets}
          otpConfig={whatsAppData.otpConfig}
          detailMode
          flash={whatsAppFlash}
          general={whatsAppData.general}
          profiles={whatsAppData.profiles}
          templates={whatsAppData.templates}
          webhookUrl={webhookUrl}
        />
      ) : null}
      {showFacebookDetails && !facebookProfiles.error ? (
        <MetaChannelProfilesPanel
          canEdit={permission.canEdit || permission.canAdd}
          enabled={data.settings.is_facebook_enabled}
          platform="facebook"
          profiles={facebookProfiles.profiles}
        />
      ) : null}
      {showInstagramDetails && !instagramProfiles.error ? (
        <MetaChannelProfilesPanel
          canEdit={permission.canEdit || permission.canAdd}
          enabled={data.settings.is_instagram_enabled}
          platform="instagram"
          profiles={instagramProfiles.profiles}
        />
      ) : null}
    </AppShell>
  );
}
