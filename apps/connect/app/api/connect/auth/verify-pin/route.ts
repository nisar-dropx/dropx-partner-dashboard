import { NextResponse } from "next/server";
import { createConnectSession, findConnectAccounts, normalizeConnectMobile, verifySecretHash } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown; pin?: unknown };
    const { countryCode, mobile } = normalizeConnectMobile(body.mobile, body.countryCode);
    const pin = String(body.pin ?? "").replace(/\D/g, "");
    if (!mobile || mobile.length < 7) return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    if (!/^\d{6}$/.test(pin)) return NextResponse.json({ error: "Enter your 6 digit PIN." }, { status: 400 });

    const pinResult = await supabaseAdmin
      .from("connect_user_pins")
      .select("id, pin_hash, attempt_count, locked_until, reset_required")
      .eq("country_code", countryCode)
      .eq("mobile_number", mobile)
      .maybeSingle();
    if (pinResult.error) throw new Error(pinResult.error.message);
    const pinRow = pinResult.data;
    if (!pinRow || pinRow.reset_required) return NextResponse.json({ error: "PIN not created. Please verify OTP and create a PIN." }, { status: 400 });
    if (pinRow.locked_until && new Date(pinRow.locked_until).getTime() > Date.now()) {
      return NextResponse.json({ error: "PIN is temporarily locked. Please try later or reset PIN." }, { status: 429 });
    }

    if (!verifySecretHash(pin, pinRow.pin_hash)) {
      const attempts = (pinRow.attempt_count ?? 0) + 1;
      await supabaseAdmin.from("connect_user_pins").update({
        attempt_count: attempts,
        locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
        updated_at: new Date().toISOString()
      }).eq("id", pinRow.id);
      return NextResponse.json({ error: attempts >= 5 ? "Too many wrong attempts. PIN locked for 15 minutes." : "Invalid PIN." }, { status: 400 });
    }

    await supabaseAdmin.from("connect_user_pins").update({
      attempt_count: 0,
      locked_until: null,
      updated_at: new Date().toISOString()
    }).eq("id", pinRow.id);

    const accounts = await findConnectAccounts(countryCode, mobile);
    if (!accounts.length) {
      return NextResponse.json({
        error: "You don't have access to DropX One. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }
    await createConnectSession({ countryCode, mobile, request });
    return NextResponse.json({ ok: true, accounts });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify PIN." }, { status: 500 });
  }
}
