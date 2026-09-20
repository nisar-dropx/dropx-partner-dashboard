import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { loadConnectReporteeAccess } from "../../../../src/lib/connect-reportee-scope";
import { resolveConnectActorUserIds } from "../../../../src/lib/connect-approver-identity";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Tells the client whether this account has reportees or a pending assigned
 * approval, including approvers from another department without direct reports.
 * The inbox APIs independently enforce the exact assignment on each action.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (!accountId || !profileType) throw new Error("Account is required.");
    if (profileType !== "user" && profileType !== "employee" && profileType !== "contractor") {
      return NextResponse.json({ hasReportees: false });
    }
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const reportees = await loadConnectReporteeAccess(account, "team");
    let hasApprovalAccess = reportees.assignmentIds.size > 0;
    if (!hasApprovalAccess) {
      const actorIds = await resolveConnectActorUserIds(account);
      if (actorIds.length) {
        if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
        const assigned = await supabaseAdmin.from("hr_pending_manager_approval_emails").select("request_id")
          .eq("company_id", account.companyId).in("approver_user_id", actorIds).eq("recipient_active", true).limit(1);
        if (assigned.error) throw new Error(assigned.error.message);
        hasApprovalAccess = Boolean(assigned.data?.length);
      }
    }
    return NextResponse.json({ hasReportees: hasApprovalAccess }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // An unavailable check must not be interpreted as a confirmed loss of access.
    console.error("[connect/approver-status] Unable to resolve reporting access.");
    return NextResponse.json({ error: "Unable to check approval access. Please retry." }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" }
    });
  }
}
