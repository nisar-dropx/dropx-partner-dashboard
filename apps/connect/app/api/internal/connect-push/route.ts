import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { deliverNotificationPush } from "@/lib/firebase-push";
import { validPushSignature } from "@/lib/connect-push-auth";

export const maxDuration = 60;
/** Trusted People server sends only an ID. Never accept recipients or message bodies from callers. */
export async function POST(request: Request) {
  const body = await request.text();
  if (body.length > 250 || !validPushSignature(process.env.CONNECT_PUSH_RELAY_SECRET ?? "", request.headers.get("x-dropx-time") ?? "", body, request.headers.get("x-dropx-signature") ?? "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!supabaseAdmin) throw new Error("Delivery unavailable");
    const input = JSON.parse(body);
    if (!/^[a-f0-9-]{36}$/i.test(String(input.notificationId ?? ""))) return NextResponse.json({ error: "Invalid notification" }, { status: 400 });
    const result = await supabaseAdmin.rpc("claim_connect_push", { p_notification_id: input.notificationId });
    if (result.error) throw result.error;
    const row = result.data?.[0];
    if (!row) return NextResponse.json({ ok: true, skipped: true });
    await deliverNotificationPush({ id: row.id, companyId: row.company_id, profileType: row.recipient_profile_type,
      accountId: row.recipient_account_id, title: row.title, body: row.body, route: row.route, data: row.data ?? {} });
    const status = await supabaseAdmin.from("mob_app_notifications").select("push_status").eq("id", row.id).single();
    return NextResponse.json({ ok: !status.error, status: status.data?.push_status ?? "failed" });
  } catch {
    return NextResponse.json({ error: "Push delivery unavailable; the in-app notification is retained." }, { status: 503 });
  }
}
