import "server-only";
import { NextResponse } from "next/server";
import { clampOtpExpiryMinutes, createOtpSecretHash, generateOtp, normalizeMobile, verifyOtpHash } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { extractWhatsAppTemplateVariables, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

export type AuthorizedMobileLoginProfile = {
  id: string;
  companyId: string;
  email: string;
  fullName: string | null;
  mobile: string;
};

type NotificationConfigRow = {
  company_id: string;
  template_id: string | null;
  whatsapp_profile_id: string | null;
  variable_mappings: Record<string, string> | null;
};

type MobileLoginOptions = {
  appName: string;
  findProfile: (mobile: unknown, countryCode: string) => Promise<AuthorizedMobileLoginProfile | null>;
  purpose: string;
};

type VerifyMobileLoginOptions = MobileLoginOptions & {
  forceOpsStorage?: boolean;
  inactiveMessage: string;
  redirectTo: string;
  safeNextPath: (value: unknown) => string;
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

export async function sendMobileLoginOtp(request: Request, options: MobileLoginOptions) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const profile = await options.findProfile(body.mobile, countryCode);
    if (!profile) {
      return NextResponse.json(
        { error: `This mobile number is not enabled for ${options.appName}.` },
        { status: 403 }
      );
    }

    const latestResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .select("created_at")
      .eq("purpose", options.purpose)
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
        .eq("purpose", options.purpose)
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
        purpose: options.purpose,
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

    const providerResponse = await fetch(`https://graph.facebook.com/${sender.graph_api_version}/${sender.phone_number_id}/messages`, {
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
            app_name: options.appName
          })
        }
      })
    });
    const payload = await providerResponse.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .update({
        status: providerResponse.ok ? "pending" : "failed",
        provider_message_id: payload.messages?.[0]?.id ?? null,
        error_message: providerResponse.ok ? null : payload.error?.message ?? "Meta rejected the WhatsApp OTP message.",
        updated_at: new Date().toISOString()
      })
      .eq("id", insertResult.data.id);

    if (!providerResponse.ok) {
      return NextResponse.json({ error: payload.error?.message ?? "Unable to send WhatsApp OTP." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, expiresInMinutes: expiryMinutes, resendAfterSeconds: 60 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to send OTP." }, { status: 500 });
  }
}

export async function verifyMobileLoginOtp(request: Request, options: VerifyMobileLoginOptions) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as {
      mobile?: unknown;
      countryCode?: unknown;
      otp?: unknown;
      next?: unknown;
    };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const mobile = normalizeMobile(body.mobile, countryCode);
    const otp = String(body.otp ?? "").replace(/\D/g, "");
    if (!mobile || mobile.length < 11) return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    if (!/^\d{6}$/.test(otp)) return NextResponse.json({ error: "Enter the 6 digit OTP." }, { status: 400 });

    const otpResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .select("id, otp_hash, expires_at, used_at, attempt_count, max_attempts, status")
      .eq("purpose", options.purpose)
      .eq("country_code", countryCode)
      .eq("mobile_number", mobile)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (otpResult.error) throw new Error(otpResult.error.message);
    const otpRow = otpResult.data;
    if (!otpRow || otpRow.used_at) {
      return NextResponse.json({ error: "OTP not found or already used. Please resend OTP." }, { status: 400 });
    }
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", otpRow.id);
      return NextResponse.json({ error: "OTP expired. Please resend OTP." }, { status: 400 });
    }
    if (otpRow.attempt_count >= otpRow.max_attempts) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Too many attempts. Please resend OTP." }, { status: 429 });
    }
    if (!verifyOtpHash(otp, otpRow.otp_hash)) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        attempt_count: otpRow.attempt_count + 1,
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent"),
        updated_at: new Date().toISOString()
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Invalid OTP." }, { status: 400 });
    }

    const profile = await options.findProfile(mobile, countryCode);
    if (!profile) {
      return NextResponse.json({ error: options.inactiveMessage }, { status: 403 });
    }

    const linkResult = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: { redirectTo: options.redirectTo }
    });
    if (linkResult.error || !linkResult.data.properties?.hashed_token) {
      throw new Error(linkResult.error?.message ?? `Unable to create the secure ${options.appName} session.`);
    }

    const response = NextResponse.json({ ok: true, next: options.safeNextPath(body.next) });
    const supabase = createServerSupabaseClient(response, options.forceOpsStorage);
    if (!supabase) throw new Error("Authentication is not configured.");
    const verificationResult = await supabase.auth.verifyOtp({
      token_hash: linkResult.data.properties.hashed_token,
      type: "magiclink"
    });
    if (verificationResult.error || !verificationResult.data.user) {
      throw new Error(verificationResult.error?.message ?? `Unable to verify the secure ${options.appName} session.`);
    }
    if (String(verificationResult.data.user.email ?? "").trim().toLowerCase() !== profile.email) {
      await supabase.auth.signOut({ scope: "local" });
      throw new Error(`The verified account does not match the ${options.appName} profile.`);
    }

    const updatedAt = new Date().toISOString();
    const updateResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .update({
        status: "verified",
        used_at: updatedAt,
        attempt_count: otpRow.attempt_count + 1,
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent"),
        updated_at: updatedAt
      })
      .eq("id", otpRow.id)
      .eq("status", "pending")
      .is("used_at", null)
      .select("id")
      .maybeSingle();
    if (updateResult.error || !updateResult.data) {
      await supabase.auth.signOut({ scope: "local" });
      throw new Error(updateResult.error?.message ?? "This OTP has already been used. Please request another OTP.");
    }
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify OTP." }, { status: 500 });
  }
}
