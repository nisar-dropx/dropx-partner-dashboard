import { createHash } from "crypto";
import { userFacingError } from "@/lib/user-facing-error";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectSessionAccounts } from "@/lib/connect-auth";
import { getConnectPreviewActor, previewNoStore } from "@/lib/connect-preview";
import { connectPreviewCookieName } from "@/lib/connect-preview-policy";
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
    if (!cookies().get(connectPreviewCookieName)?.value) await supabaseAdmin.from("connect_login_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
    const accounts = await findConnectSessionAccounts(session.country_code, session.mobile_number);
    if (!accounts.length) {
      // A missing account must deny access, but it must not silently destroy a
      // valid 180-day device session. Workforce records can be momentarily
      // unavailable while a profile/designation update is propagating; deleting
      // the cookie here was forcing users through PIN/biometric sign-in again.
      return NextResponse.json({
        authenticated: false,
        error: "You don't have access to DropX One. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }
    const actor = await getConnectPreviewActor(cookies().get(connectPreviewCookieName)?.value ? undefined : accounts).catch(() => null);
    return NextResponse.json({
      authenticated: true,
      canPreviewUsers: Boolean(actor?.companyIds.length),
      preview: Boolean(cookies().get(connectPreviewCookieName)?.value),
      accounts,
      countryCode: session.country_code,
      mobile: session.mobile_number.startsWith(session.country_code)
        ? session.mobile_number.slice(session.country_code.length)
        : session.mobile_number
    }, { headers: previewNoStore });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load session."), preview: Boolean(cookies().get(connectPreviewCookieName)?.value) }, { status: 500, headers: previewNoStore });
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
        .update({ revoked_at: new Date().toISOString() })
        .eq("session_hash", sessionHash);
    }
    cookies().delete(connectSessionCookieName);
    cookies().delete(connectPreviewCookieName);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to clear session.") }, { status: 500 });
  }
}
