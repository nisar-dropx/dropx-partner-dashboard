import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function setupMessage(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "");
  return message.toLowerCase().includes("mob_app_notifications")
    ? "App notifications are not configured. Run scripts/mob_app_notifications_v1.sql in Supabase."
    : message || "Unable to load notifications.";
}

async function selectedAccount(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  const profileType = String(body?.profileType ?? url.searchParams.get("profileType") ?? "") as ConnectAccount["profileType"];
  const accountId = String(body?.accountId ?? url.searchParams.get("accountId") ?? "");
  return requireConnectAccount(profileType, accountId);
}

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const account = await selectedAccount(request);
    const result = await supabaseAdmin
      .from("mob_app_notifications")
      .select("id, event_code, title, body, route, data, created_at, read_at")
      .eq("company_id", account.companyId)
      .eq("recipient_profile_type", account.profileType)
      .eq("recipient_account_id", account.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (result.error) throw result.error;

    const rows = result.data ?? [];
    const requestIds = [...new Set(rows.flatMap((row) => {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const id = String(data.claimRequestId ?? "").trim();
      return row.event_code === "REIMBURSEMENT_REQUEST_APPROVAL_REQUIRED" && id ? [id] : [];
    }))];
    const claimIds = [...new Set(rows.flatMap((row) => {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const id = String(data.claimId ?? "").trim();
      return row.event_code === "REIMBURSEMENT_APPROVAL_REQUIRED" && id ? [id] : [];
    }))];

    const staleIds = new Set<string>();
    if (requestIds.length) {
      const requests = await supabaseAdmin.from("hr_expense_claim_requests")
        .select("id,status")
        .eq("company_id", account.companyId)
        .in("id", requestIds);
      if (!requests.error) {
        const pending = new Set((requests.data ?? []).filter((row) => row.status === "pending").map((row) => row.id));
        for (const row of rows) {
          const data = (row.data ?? {}) as Record<string, unknown>;
          const id = String(data.claimRequestId ?? "").trim();
          if (row.event_code === "REIMBURSEMENT_REQUEST_APPROVAL_REQUIRED" && id && !pending.has(id)) staleIds.add(row.id);
        }
      }
    }
    if (claimIds.length) {
      const steps = await supabaseAdmin.from("hr_expense_approval_steps")
        .select("claim_id,status,approver_user_id")
        .eq("company_id", account.companyId)
        .in("claim_id", claimIds)
        .eq("status", "pending");
      const actorUserId = account.profileType === "user" ? account.id : null;
      let linkedUserId = actorUserId;
      if (!linkedUserId && (account.profileType === "employee" || account.profileType === "contractor")) {
        const identity = await supabaseAdmin.from("hr_engagements")
          .select("person_id")
          .eq("company_id", account.companyId)
          .eq(account.profileType === "employee" ? "employee_id" : "contractor_id", account.id)
          .eq("status", "active")
          .maybeSingle();
        if (identity.data?.person_id) {
          const link = await supabaseAdmin.from("hr_user_person_links")
            .select("user_id,status")
            .eq("company_id", account.companyId)
            .eq("person_id", identity.data.person_id)
            .maybeSingle();
          if (link.data?.status === "active") linkedUserId = link.data.user_id;
        }
      }
      const pendingClaims = new Set(
        (steps.data ?? [])
          .filter((step) => !linkedUserId || step.approver_user_id === linkedUserId)
          .map((step) => step.claim_id)
      );
      for (const row of rows) {
        const data = (row.data ?? {}) as Record<string, unknown>;
        const id = String(data.claimId ?? "").trim();
        if (row.event_code === "REIMBURSEMENT_APPROVAL_REQUIRED" && id && !pendingClaims.has(id)) staleIds.add(row.id);
      }
    }

    if (staleIds.size) {
      const now = new Date().toISOString();
      await supabaseAdmin.from("mob_app_notifications")
        .update({ read_at: now, archived_at: now })
        .eq("company_id", account.companyId)
        .in("id", [...staleIds]);
    }

    const notifications = rows.filter((row) => !staleIds.has(row.id));
    return NextResponse.json({
      notifications,
      unreadCount: notifications.filter((row) => !row.read_at).length
    });
  } catch (error) {
    return NextResponse.json({ error: setupMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const notificationId = String(body.notificationId ?? "").trim();
    const markAll = body.markAll === true;
    if (!notificationId && !markAll) {
      return NextResponse.json({ error: "Select a notification to mark as read." }, { status: 400 });
    }
    let query = supabaseAdmin
      .from("mob_app_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("company_id", account.companyId)
      .eq("recipient_profile_type", account.profileType)
      .eq("recipient_account_id", account.id)
      .is("archived_at", null)
      .is("read_at", null);
    if (!markAll) query = query.eq("id", notificationId);
    const result = await query;
    if (result.error) throw result.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: setupMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const deviceId = String(body.deviceId ?? "").trim();
    const pushToken = String(body.pushToken ?? "").trim();
    const appVersion = String(body.appVersion ?? "").trim();
    // Defaults to "android" for backward compatibility with callers that
    // predate the DropX One Flutter app (it always sends its own platform).
    const requestedPlatform = String(body.platform ?? "android").trim().toLowerCase();
    const platform = requestedPlatform === "ios" ? "ios" : "android";
    if (!deviceId || !pushToken) {
      return NextResponse.json({ error: "Device ID and push token are required." }, { status: 400 });
    }
    if (deviceId.length > 200 || pushToken.length > 4096 || appVersion.length > 80) {
      return NextResponse.json({ error: "Invalid device registration details." }, { status: 400 });
    }
    const now = new Date().toISOString();
    const result = await supabaseAdmin
      .from("mob_app_device_tokens")
      .upsert({
        company_id: account.companyId,
        profile_type: account.profileType,
        account_id: account.id,
        platform,
        device_id: deviceId,
        push_token: pushToken,
        app_version: appVersion || null,
        is_active: true,
        last_seen_at: now,
        updated_at: now
      }, {
        onConflict: "company_id,profile_type,account_id,device_id"
      });
    if (result.error) throw result.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: setupMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const deviceId = String(body.deviceId ?? "").trim();
    if (!deviceId) {
      return NextResponse.json({ error: "Device ID is required." }, { status: 400 });
    }
    const result = await supabaseAdmin
      .from("mob_app_device_tokens")
      .update({
        is_active: false,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("company_id", account.companyId)
      .eq("profile_type", account.profileType)
      .eq("account_id", account.id)
      .eq("device_id", deviceId);
    if (result.error) throw result.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: setupMessage(error) }, { status: 500 });
  }
}
