import { NextResponse } from "next/server";
import { createOtpSecretHash, clampOtpExpiryMinutes, generateOtp, normalizeMobile } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { extractWhatsAppTemplateVariables, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

type NotificationConfigRow = {
  company_id: string;
  is_enabled: boolean;
  template_id: string | null;
  template_name: string | null;
  template_language: string | null;
  whatsapp_profile_id: string | null;
  variable_mappings: Record<string, string> | null;
};

type AccountMatchResult = {
  data: Array<{ company_id?: string | null }> | null;
  error: { message?: string } | null;
};

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

function messageValue(source: string | undefined, values: Record<string, string>) {
  if (!source) return "";
  return values[source] ?? source;
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function buildTemplateComponents(components: WhatsAppTemplateComponent[], mappings: Record<string, string>, values: Record<string, string>) {
  const variables = extractWhatsAppTemplateVariables(components);
  const messageComponents: Array<Record<string, unknown>> = [];

  (["header", "body"] as const).forEach((componentType) => {
    const componentVariables = variables
      .filter((variable) => variable.component === componentType)
      .sort((first, second) => first.position - second.position);
    if (!componentVariables.length) return;
    messageComponents.push({
      type: componentType,
      parameters: componentVariables.map((variable) => ({
        type: "text",
        text: messageValue(mappings[variable.key], values)
      }))
    });
  });

  variables.filter((variable) => variable.component === "button").forEach((variable) => {
    messageComponents.push({
      type: "button",
      sub_type: "url",
      index: String(variable.buttonIndex ?? 0),
      parameters: [{ type: "text", text: messageValue(mappings[variable.key], values) }]
    });
  });

  return messageComponents;
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown; purpose?: unknown };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const purpose = String(body.purpose ?? "connect_login") === "connect_pin_reset" ? "connect_pin_reset" : "connect_login";
    const to = normalizeMobile(body.mobile, countryCode);
    if (!to || to.length < 11) {
      return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    }

    const localMobile = to.startsWith(countryCode) ? to.slice(countryCode.length) : to;
    let [profileMatches, executiveMatches, employeeMatches]: [AccountMatchResult, AccountMatchResult, AccountMatchResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, company_id, is_active, mobile_country_code")
        .eq("is_active", true)
        .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
        .or(`mobile.eq.${to},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("field_executives")
        .select("id, company_id, is_active, mobile_country_code")
        .eq("is_active", true)
        .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
        .or(`mobile.eq.${to},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("employees")
        .select("id, company_id, is_active, mobile_country_code")
        .eq("is_active", true)
        .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
        .or(`mobile.eq.${to},mobile.eq.${localMobile}`)
    ]);
    if (isMissingColumnError(profileMatches.error) || isMissingColumnError(executiveMatches.error) || isMissingColumnError(employeeMatches.error)) {
      [profileMatches, executiveMatches, employeeMatches] = await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("id, company_id, is_active")
          .eq("is_active", true)
          .or(`mobile.eq.${to},mobile.eq.${localMobile}`),
        supabaseAdmin
          .from("field_executives")
          .select("id, company_id, is_active")
          .eq("is_active", true)
          .or(`mobile.eq.${to},mobile.eq.${localMobile}`),
        supabaseAdmin
          .from("employees")
          .select("id, company_id, is_active")
          .eq("is_active", true)
          .or(`mobile.eq.${to},mobile.eq.${localMobile}`)
      ]);
    }
    if (profileMatches.error) throw new Error(profileMatches.error.message);
    if (executiveMatches.error) throw new Error(executiveMatches.error.message);
    if (employeeMatches.error) throw new Error(employeeMatches.error.message);
    const companyIds = Array.from(new Set([
      ...(profileMatches.data ?? []).map((profile) => profile.company_id),
      ...(executiveMatches.data ?? []).map((executive) => executive.company_id),
      ...(employeeMatches.data ?? []).map((employee) => employee.company_id)
    ].filter(Boolean)));
    if (!companyIds.length) {
      return NextResponse.json({
        error: "You don't have access to DropX Connect. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }

    const configsResult = await supabaseAdmin
      .from("whatsapp_notification_configs")
      .select("company_id, is_enabled, template_id, template_name, template_language, whatsapp_profile_id, variable_mappings")
      .in("company_id", companyIds)
      .eq("event_code", "onboarding_otp_verification")
      .eq("is_enabled", true)
      .limit(1);
    if (configsResult.error) throw new Error(configsResult.error.message);
    const config = (configsResult.data?.[0] ?? null) as NotificationConfigRow | null;
    if (!config?.template_id || !config.whatsapp_profile_id) {
      return NextResponse.json({ error: "Onboarding OTP WhatsApp template is not configured." }, { status: 400 });
    }

    const [settingsResult, profileResult, tokenResult, templateResult] = await Promise.all([
      supabaseAdmin
        .from("whatsapp_settings")
        .select("is_enabled")
        .eq("company_id", config.company_id)
        .eq("id", true)
        .maybeSingle(),
      supabaseAdmin
        .from("whatsapp_profiles")
        .select("id, phone_number_id, graph_api_version, default_country_code, is_active")
        .eq("company_id", config.company_id)
        .eq("id", config.whatsapp_profile_id)
        .maybeSingle(),
      supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: config.whatsapp_profile_id }),
      supabaseAdmin
        .from("whatsapp_template_cache")
        .select("template_id, name, language, status, components")
        .eq("company_id", config.company_id)
        .eq("template_id", config.template_id)
        .maybeSingle()
    ]);
    if (settingsResult.error) throw new Error(settingsResult.error.message);
    if (profileResult.error) throw new Error(profileResult.error.message);
    if (tokenResult.error) throw new Error(tokenResult.error.message);
    if (templateResult.error) throw new Error(templateResult.error.message);
    if (!settingsResult.data?.is_enabled) throw new Error("WhatsApp is disabled.");
    const whatsappProfile = profileResult.data;
    const template = templateResult.data;
    if (!whatsappProfile?.is_active || !whatsappProfile.phone_number_id || !tokenResult.data) {
      throw new Error("WhatsApp sender profile is incomplete.");
    }
    if (!template || template.status !== "APPROVED") {
      throw new Error("Selected OTP WhatsApp template is not approved.");
    }

    const otp = generateOtp();
    const mappings = config.variable_mappings ?? {};
    const expiryMinutes = clampOtpExpiryMinutes(mappings.__otp_expiry_minutes);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
    const values: Record<string, string> = {
      otp_code: otp,
      expiry_minutes: String(expiryMinutes),
      app_name: "DropX Connect"
    };
    const requestPayload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: buildTemplateComponents((template.components ?? []) as WhatsAppTemplateComponent[], mappings, values)
      }
    };

    const response = await fetch(`https://graph.facebook.com/${whatsappProfile.graph_api_version}/${whatsappProfile.phone_number_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.data}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestPayload)
    });
    const responsePayload = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    const providerMessageId = responsePayload.messages?.[0]?.id ?? null;

    const insertResult = await supabaseAdmin.from("connect_whatsapp_otp_requests").insert({
      company_id: config.company_id,
      purpose,
      country_code: countryCode,
      mobile_number: to,
      otp_hash: createOtpSecretHash(otp),
      expires_at: expiresAt,
      status: response.ok ? "pending" : "failed",
      whatsapp_profile_id: config.whatsapp_profile_id,
      template_id: template.template_id,
      template_name: template.name,
      template_language: template.language,
      provider_message_id: providerMessageId,
      error_message: response.ok ? null : responsePayload.error?.message ?? "Meta rejected the WhatsApp OTP message.",
      request_ip: requestIp(request),
      user_agent: request.headers.get("user-agent")
    });
    if (insertResult.error) throw new Error(insertResult.error.message);

    if (!response.ok) {
      return NextResponse.json({ error: responsePayload.error?.message ?? "Unable to send WhatsApp OTP." }, { status: 502 });
    }

    return NextResponse.json({ ok: true, channel: "whatsapp", expiresInMinutes: expiryMinutes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to send OTP." }, { status: 500 });
  }
}
