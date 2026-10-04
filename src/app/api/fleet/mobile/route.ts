import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership, loadFleetControlData } from "@/lib/fleet-control";
import { fleetAccessPageCodes } from "@/lib/access-surface";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const companyId = requireCompanyId(authorization);
  const hasMembership = authorization.isMasterOwner || await hasActiveFleetMembership(companyId, authorization.userId);
  const canEnter = hasMembership && fleetAccessPageCodes.some((code) => hasPermission(authorization, code, "access"));
  if (!canEnter) {
    return NextResponse.json({ error: "You do not have access to DropX Fleet. Contact HR or your department administrator." }, { status: 403 });
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
