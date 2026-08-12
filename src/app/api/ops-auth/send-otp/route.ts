import { NextResponse } from "next/server";
import { clampOtpExpiryMinutes, createOtpSecretHash, generateOtp } from "@/lib/connect-otp";
import { findAuthorizedOpsProfileByMobile } from "@/lib/ops-pulse/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { extractWhatsAppTemplateVariables, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

export const dynamic = "force-dynamic";

type NotificationConfigRow = {
  company_id: string;
  template_id: string | null;
  whatsapp_profile_id: string | null;
  variable_mappings: Record<string, string> | null;
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

function buildTemplateComponents(
  components: WhatsAppTemplateComponent[],
  mappings: Record<string, string>,
  values: Record<string, string>
) {
  const variables = extractWhatsAppTemplateVariables(components);
  const result: Array<Record<string, unknown>> = [];
  (["header", "body"] as const).forEach((componentType) => {
    const componentVariables = variables
      .filter((variable) => variable.component === componentType)
      .sort((first, second) => first.position - second.position);
    if (!componentVariables.length) return;
    result.push({
      type: componentType,
      parameters: componentVariables.map((variable) => ({
        type: "text",
        text: messageValue(mappings[variable.key], values)
      }))
    });
  });
  variables.filter((variable) => variable.component === "button").forEach((variable) => {
    result.push({
      type: "button",
      sub_type: "url",
      index: String(variable.buttonIndex ?? 0),
      parameters: [{ type: "text", text: messageValue(mappings[variable.key], values) }]
    });
  });
  return result;
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const profile = await findAuthorizedOpsProfileByMobile(body.mobile, countryCode);
    if (!profile) {
      return NextResponse.json(
        { error: "This mobile number is not enabled for OpsPulse." },
        { status: 403 }
      );
    }

    const latestResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .select("created_at")
      .eq("purpose", "ops_login")
      .eq("mobile_number", profile.mobile)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestResult.error) throw new Error(latestResult.error.message);
    const lastCreatedAt = latestResult.data?.created_at ? new Date(latestResult.data.created_at).getTime() : 0;
    const secondsSinceLast = Math.floor((Date.now() - lastCreatedAt) / 1000);
    if (lastCreatedAt && secondsSinceLast < 60) {
      return NextResponse.json(
        { error: `Please wait ${60 - secondsSinceLast} seconds before requesting another OTP.`, retryAfter: 60 - secondsSinceLast },
        { status: 429, headers: { "Retry-After": String(60 - secondsSinceLast) } }
      );
    }

    const ip = requestIp(request);
    if (ip) {
      const recentIpResult = await supabaseAdmin
        .from("connect_whatsapp_otp_requests")
        .select("id", { count: "exact", head: true })
        .eq("purpose", "ops_login")
        .eq("request_ip", ip)
        .gte("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
      if (recentIpResult.error) throw new Error(recentIpResult.error.message);
      if ((recentIpResult.count ?? 0) >= 8) {
        return NextResponse.json({ error: "Too many OTP requests. Try again in a few minutes." }, { status: 429 });
      }
    }

    const configsResult = await supabaseAdmin
      .from("whatsapp_notification_configs")
      .select("company_id, template_id, whatsapp_profile_id, variable_mappings")
      .eq("company_id", profile.companyId)
      .eq("event_code", "onboarding_otp_verification")
      .eq("is_enabled", true)
      .limit(1);
    if (configsResult.error) throw new Error(configsResult.error.message);
    const config = (configsResult.data?.[0] ?? null) as NotificationConfigRow | null;
    if (!config?.template_id || !config.whatsapp_profile_id) {
      return NextResponse.json({ error: "WhatsApp OTP is not configured for your company." }, { status: 503 });
    }

    const [settingsResult, senderResult, tokenResult, templateResult] = await Promise.all([
      supabaseAdmin.from("whatsapp_settings").select("is_enabled").eq("company_id", profile.companyId).eq("id", true).maybeSingle(),
      supabaseAdmin.from("whatsapp_profiles").select("phone_number_id, graph_api_version, is_active").eq("company_id", profile.companyId).eq("id", config.whatsapp_profile_id).maybeSingle(),
      supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: config.whatsapp_profile_id }),
      supabaseAdmin.from("whatsapp_template_cache").select("template_id, name, language, status, components").eq("company_id", profile.companyId).eq("template_id", config.template_id).maybeSingle()
    ]);
    if (settingsResult.error) throw new Error(settingsResult.error.message);
    if (senderResult.error) throw new Error(senderResult.error.message);
    if (tokenResult.error) throw new Error(tokenResult.error.message);
    if (templateResult.error) throw new Error(templateResult.error.message);
    if (!settingsResult.data?.is_enabled) throw new Error("WhatsApp messaging is disabled.");
    const sender = senderResult.data;
    const template = templateResult.data;
    if (!sender?.is_active || !sender.phone_number_id || !tokenResult.data) throw new Error("WhatsApp sender is incomplete.");
    if (!template || template.status !== "APPROVED") throw new Error("The WhatsApp OTP template is not approved.");

    const otp = generateOtp();
    const mappings = config.variable_mappings ?? {};
    const expiryMinutes = clampOtpExpiryMinutes(mappings.__otp_expiry_minutes);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
    const insertResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .insert({
        company_id: profile.companyId,
        purpose: "ops_login",
        country_code: countryCode,
        mobile_number: profile.mobile,
        otp_hash: createOtpSecretHash(otp),
        expires_at: expiresAt,
        status: "pending",
        whatsapp_profile_id: config.whatsapp_profile_id,
        template_id: template.template_id,
        template_name: template.name,
        template_language: template.language,
        request_ip: ip,
        user_agent: request.headers.get("user-agent")
      })
      .select("id")
      .single();
    if (insertResult.error) throw new Error(insertResult.error.message);

    const response = await fetch(`https://graph.facebook.com/${sender.graph_api_version}/${sender.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenResult.data}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: profile.mobile,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: buildTemplateComponents((template.components ?? []) as WhatsAppTemplateComponent[], mappings, {
            otp_code: otp,
            expiry_minutes: String(expiryMinutes),
            app_name: "DropX OpsPulse"
          })
        }
      })
    });
    const payload = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .update({
        status: response.ok ? "pending" : "failed",
        provider_message_id: payload.messages?.[0]?.id ?? null,
        error_message: response.ok ? null : payload.error?.message ?? "Meta rejected the WhatsApp OTP message.",
        updated_at: new Date().toISOString()
      })
      .eq("id", insertResult.data.id);

    if (!response.ok) {
      return NextResponse.json({ error: payload.error?.message ?? "Unable to send WhatsApp OTP." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, expiresInMinutes: expiryMinutes, resendAfterSeconds: 60 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to send OTP." }, { status: 500 });
  }
}
