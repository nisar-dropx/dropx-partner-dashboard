import { NextResponse } from "next/server";
import { normalizeMobile, verifyOtpHash } from "@/lib/connect-otp";
import { findAuthorizedOpsProfileByMobile, safeOpsNextPath } from "@/lib/ops-pulse/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

export async function POST(request: Request) {
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
      .eq("purpose", "ops_login")
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

    const profile = await findAuthorizedOpsProfileByMobile(mobile, countryCode);
    if (!profile) {
      return NextResponse.json({ error: "Your OpsPulse access is no longer active." }, { status: 403 });
    }

    const linkResult = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: { redirectTo: "https://ops.dropxlogistics.com/" }
    });
    if (linkResult.error || !linkResult.data.properties?.hashed_token) {
      throw new Error(linkResult.error?.message ?? "Unable to create the secure OpsPulse session.");
    }

    const response = NextResponse.json({ ok: true, next: safeOpsNextPath(body.next) });
    const supabase = createServerSupabaseClient(response, true);
    if (!supabase) throw new Error("Authentication is not configured.");
    const verificationResult = await supabase.auth.verifyOtp({
      token_hash: linkResult.data.properties.hashed_token,
      type: "magiclink"
    });
    if (verificationResult.error || !verificationResult.data.user) {
      throw new Error(verificationResult.error?.message ?? "Unable to verify the secure OpsPulse session.");
    }
    if (String(verificationResult.data.user.email ?? "").trim().toLowerCase() !== profile.email) {
      await supabase.auth.signOut({ scope: "local" });
      throw new Error("The verified account does not match the OpsPulse profile.");
    }

    const updatedAt = new Date().toISOString();
    const updateResult = await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
      status: "verified",
      used_at: updatedAt,
      attempt_count: otpRow.attempt_count + 1,
      request_ip: requestIp(request),
      user_agent: request.headers.get("user-agent"),
      updated_at: updatedAt
    }).eq("id", otpRow.id);
    if (updateResult.error) throw new Error(updateResult.error.message);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify OTP." }, { status: 500 });
  }
}
