import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "@/lib/connect-auth";
import { writeEventLog } from "@/lib/event-log";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin.from("connect_login_sessions")
    .select("country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash).maybeSingle();
  const session = sessionResult.data;
  if (sessionResult.error || !session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const accountId = String(body.accountId ?? "");
  const profileType = String(body.profileType ?? "");
  const accounts = await findConnectAccounts(session.country_code, session.mobile_number);
  const account = accounts.find((item) => item.id === accountId && item.profileType === profileType);
  if (!account) return NextResponse.json({ error: "Account not available" }, { status: 403 });
  const platform = body.platform === "dropx_one_android" ? "dropx_one_android" : "dropx_one_web";
  await writeEventLog({
    companyId: account.companyId,
    platform,
    eventCode: String(body.eventCode ?? "app_action"),
    module: String(body.module ?? "dropx_one"),
    action: String(body.action ?? "view"),
    outcome: body.outcome === "failed" || body.outcome === "success" || body.outcome === "warning" ? body.outcome : "info",
    actorType: profileType,
    actorAccountId: account.id,
    actorLabel: account.name,
    actorIdentifier: `+${session.country_code} ${String(session.mobile_number).replace(session.country_code, "")}`,
    subjectType: profileType,
    subjectId: account.id,
    subjectCode: account.reference,
    subjectLabel: account.name,
    route: String(body.route ?? ""),
    method: request.method,
    metadata: typeof body.metadata === "object" && body.metadata ? body.metadata as Record<string, unknown> : {},
    request
  });
  return NextResponse.json({ ok: true });
}
