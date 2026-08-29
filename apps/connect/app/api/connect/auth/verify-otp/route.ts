import { NextResponse } from "next/server";
import { findConnectAccounts } from "@/lib/connect-auth";
import { normalizeMobile, verifyOtpHash } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown; otp?: unknown };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const mobile = normalizeMobile(body.mobile, countryCode);
    const otp = String(body.otp ?? "").replace(/\D/g, "");
    if (!mobile || mobile.length < 11) {
      return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    }
    if (!/^\d{6}$/.test(otp)) {
      return NextResponse.json({ error: "Enter the 6 digit OTP." }, { status: 400 });
    }

    const otpResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .select("id, company_id, otp_hash, expires_at, used_at, attempt_count, max_attempts, status")
      .eq("purpose", "connect_login")
      .eq("country_code", countryCode)
      .eq("mobile_number", mobile)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (otpResult.error) throw new Error(otpResult.error.message);
    const otpRow = otpResult.data;
    if (!otpRow) {
      return NextResponse.json({ error: "OTP not found or already used. Please resend OTP." }, { status: 400 });
    }
    if (otpRow.used_at) {
      return NextResponse.json({ error: "OTP already used. Please resend OTP." }, { status: 400 });
    }
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        status: "expired",
        updated_at: new Date().toISOString(),
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent")
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "OTP expired. Please resend OTP." }, { status: 400 });
    }
    if (otpRow.attempt_count >= otpRow.max_attempts) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        status: "failed",
        updated_at: new Date().toISOString()
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Too many attempts. Please resend OTP." }, { status: 429 });
    }

    const isValid = verifyOtpHash(otp, otpRow.otp_hash);
    if (!isValid) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        attempt_count: otpRow.attempt_count + 1,
        updated_at: new Date().toISOString(),
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent")
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Invalid OTP." }, { status: 400 });
    }

    await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
      status: "verified",
      used_at: new Date().toISOString(),
      attempt_count: otpRow.attempt_count + 1,
      updated_at: new Date().toISOString(),
      request_ip: requestIp(request),
      user_agent: request.headers.get("user-agent")
    }).eq("id", otpRow.id);

    const accounts = await findConnectAccounts(countryCode, mobile);
    if (!accounts.length) {
      return NextResponse.json({
        error: "You don't have access to DropX One. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      accounts
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify OTP." }, { status: 500 });
  }
}
