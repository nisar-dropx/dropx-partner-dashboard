import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

async function currentLogin() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const result = await supabaseAdmin
    .from("connect_login_sessions")
    .select("country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const session = result.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new Error("Connect session expired. Please log in again.");
  }
  return { countryCode: session.country_code, mobile: session.mobile_number };
}

export async function PUT(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const login = await currentLogin();
    const body = await request.json().catch(() => ({})) as {
      accountId?: unknown;
      companyId?: unknown;
      profileType?: unknown;
    };
    const accountId = String(body.accountId ?? "").trim();
    const companyId = String(body.companyId ?? "").trim();
    const profileType = String(body.profileType ?? "").trim().toLowerCase();
    const accounts = await findConnectAccounts(login.countryCode, login.mobile);
    const account = accounts.find((row) =>
      row.id === accountId &&
      row.companyId === companyId &&
      row.profileType === profileType
    );
    if (!account) {
      return NextResponse.json({ error: "Selected account is not available for this login." }, { status: 400 });
    }

    const result = await supabaseAdmin.from("mob_app_user_preferences").upsert({
      country_code: login.countryCode,
      mobile_number: login.mobile,
      default_company_id: account.companyId,
      default_profile_type: account.profileType,
      default_account_id: account.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "country_code,mobile_number" });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save default account." }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const login = await currentLogin();
    const result = await supabaseAdmin
      .from("mob_app_user_preferences")
      .delete()
      .eq("country_code", login.countryCode)
      .eq("mobile_number", login.mobile);
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to remove default account." }, { status: 500 });
  }
}
