import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { loadConnectReporteeAccess } from "../../../../src/lib/connect-reportee-scope";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Tells the client whether this account has anyone reporting to them right
 * now, so the Approval Inbox nav item can be gated on actually having
 * reportees rather than on account type/page-access alone. Deliberately
 * cheap: it only resolves the reporting-tree membership check that
 * loadConnectReporteeAccess already does for the approvals list, without
 * loading any of the pending approval rows themselves.
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
    return NextResponse.json({ hasReportees: reportees.assignmentIds.size > 0 }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // Fail closed: if reporting-tree membership can't be resolved, don't show
    // an approver surface that would just fail to load anything useful.
    return NextResponse.json({ hasReportees: false });
  }
}
