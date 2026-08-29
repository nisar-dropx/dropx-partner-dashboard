import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const token = cookies().get(connectSessionCookieName)?.value;
    if (!token) return NextResponse.json({ authenticated: false });
    const sessionHash = createHash("sha256").update(token).digest("hex");
    const sessionResult = await supabaseAdmin
      .from("connect_login_sessions")
      .select("id, country_code, mobile_number, expires_at, revoked_at")
      .eq("session_hash", sessionHash)
      .maybeSingle();
    if (sessionResult.error) throw new Error(sessionResult.error.message);
    const session = sessionResult.data;
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
      cookies().delete(connectSessionCookieName);
      return NextResponse.json({ authenticated: false });
    }
    await supabaseAdmin.from("connect_login_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
    const accounts = await findConnectAccounts(session.country_code, session.mobile_number);
    if (!accounts.length) {
      await supabaseAdmin
        .from("connect_login_sessions")
        .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", session.id);
      cookies().delete(connectSessionCookieName);
      return NextResponse.json({
        authenticated: false,
        error: "You don't have access to DropX Connect. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }
    return NextResponse.json({ authenticated: true, accounts });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load session." }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const token = cookies().get(connectSessionCookieName)?.value;
    if (token) {
      const sessionHash = createHash("sha256").update(token).digest("hex");
      await supabaseAdmin
        .from("connect_login_sessions")
        .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("session_hash", sessionHash);
    }
    cookies().delete(connectSessionCookieName);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to clear session." }, { status: 500 });
  }
}
