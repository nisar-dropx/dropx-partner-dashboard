import { clampOtpExpiryMinutes } from "./connect-otp";
import { supabaseAdmin } from "./supabase-admin";
import { buildConnectOtpTemplateComponents, type WhatsAppTemplateComponent } from "./whatsapp-template";

export { buildConnectOtpTemplateComponents } from "./whatsapp-template";

type NotificationConfigRow = {
  company_id: string;
  template_id: string | null;
  whatsapp_profile_id: string | null;
  variable_mappings: Record<string, string> | null;
};

export async function sendCompanyConnectOtp({
  companyId,
  to,
  otp
}: {
  companyId: string;
  to: string;
  otp: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const configResult = await supabaseAdmin
    .from("whatsapp_notification_configs")
    .select("company_id, template_id, whatsapp_profile_id, variable_mappings")
    .eq("company_id", companyId)
    .eq("event_code", "onboarding_otp_verification")
    .eq("is_enabled", true)
    .limit(1)
    .maybeSingle();
  if (configResult.error) throw new Error(configResult.error.message);
  const config = configResult.data as NotificationConfigRow | null;
  if (!config?.template_id || !config.whatsapp_profile_id) {
    throw new Error("WhatsApp OTP is not configured for this company.");
  }

  const [settingsResult, profileResult, tokenResult, templateResult] = await Promise.all([
    supabaseAdmin
      .from("whatsapp_settings")
      .select("is_enabled")
      .eq("company_id", companyId)
      .eq("id", true)
      .maybeSingle(),
    supabaseAdmin
      .from("whatsapp_profiles")
      .select("id, phone_number_id, graph_api_version, is_active")
      .eq("company_id", companyId)
      .eq("id", config.whatsapp_profile_id)
      .maybeSingle(),
    supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: config.whatsapp_profile_id }),
    supabaseAdmin
      .from("whatsapp_template_cache")
      .select("template_id, name, language, status, components")
      .eq("company_id", companyId)
      .eq("template_id", config.template_id)
      .maybeSingle()
  ]);
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (tokenResult.error) throw new Error(tokenResult.error.message);
  if (templateResult.error) throw new Error(templateResult.error.message);
  if (!settingsResult.data?.is_enabled) throw new Error("WhatsApp is disabled for this company.");
  const profile = profileResult.data;
  const template = templateResult.data;
  if (!profile?.is_active || !profile.phone_number_id || !tokenResult.data) {
    throw new Error("WhatsApp sender profile is incomplete.");
  }
  if (!template || template.status !== "APPROVED") {
    throw new Error("The configured WhatsApp OTP template is not approved.");
  }

  const mappings = config.variable_mappings ?? {};
  const expiryMinutes = clampOtpExpiryMinutes(mappings.__otp_expiry_minutes);
  const values = {
    otp_code: otp,
    expiry_minutes: String(expiryMinutes),
    app_name: "DropX One"
  };
  const requestPayload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: buildConnectOtpTemplateComponents(
        (template.components ?? []) as WhatsAppTemplateComponent[],
        mappings,
        values
      )
    }
  };
  const response = await fetch(
    `https://graph.facebook.com/${profile.graph_api_version}/${profile.phone_number_id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.data}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const responsePayload = await response.json().catch(() => ({})) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(responsePayload.error?.message || "Unable to send WhatsApp OTP.");
  }
  return {
    expiryMinutes,
    providerMessageId: responsePayload.messages?.[0]?.id ?? null,
    whatsappProfileId: config.whatsapp_profile_id,
    templateId: template.template_id,
    templateName: template.name,
    templateLanguage: template.language
  };
}
