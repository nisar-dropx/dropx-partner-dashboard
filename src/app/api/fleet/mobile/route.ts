import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership, loadFleetControlData } from "@/lib/fleet-control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const companyId = requireCompanyId(authorization);
  const canEnter = hasPermission(authorization, "fleet_action_center", "access")
    || hasPermission(authorization, "fleet_vehicle_view", "access")
    || hasPermission(authorization, "fleet_date_view", "access")
    || hasPermission(authorization, "payment_approvals", "access")
    || await hasActiveFleetMembership(companyId, authorization.userId);
  if (!canEnter) {
    return NextResponse.json({ error: "Fleet access is not enabled for this account." }, { status: 403 });
  }

  const data = await loadFleetControlData(companyId, authorization);
  const response = NextResponse.json({
    generatedAt: new Date().toISOString(),
    user: {
      id: authorization.userId,
      name: authorization.fullName,
      email: authorization.email,
      companyName: authorization.companyName,
      roleName: authorization.roleName,
      designationName: authorization.designationName,
      permissions: authorization.permissions
    },
    data
  });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
