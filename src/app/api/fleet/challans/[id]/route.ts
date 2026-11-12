import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { loadFleetChallan, resolveFleetStationCodes, teamOpsRecoveryHref } from "@/lib/fleet/challans";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    const companyId = requireCompanyId(authorization);
    if (!authorization.isMasterOwner && !(await hasActiveFleetMembership(companyId, authorization.userId))) {
      return NextResponse.json({ error: "You do not have access to DropX Fleet." }, { status: 403 });
    }
    const canAccess =
      authorization.isMasterOwner ||
      hasPermission(authorization, "fleet_vehicle_view", "access") ||
      hasPermission(authorization, "fleet_date_view", "access") ||
      hasPermission(authorization, "fleet_action_center", "access");
    if (!canAccess) return NextResponse.json({ error: "Fleet challan permission denied." }, { status: 403 });

    const id = params.id;
    const stationCodes = await resolveFleetStationCodes(authorization, companyId);
    const detail = await loadFleetChallan(companyId, id);
    if (stationCodes && !stationCodes.includes(detail.challan.stationCode)) {
      return NextResponse.json({ error: "This challan is outside your assigned stations." }, { status: 403 });
    }
    return NextResponse.json({
      ...detail,
      recoveryHref: teamOpsRecoveryHref(detail.challan.recoveryMonth, detail.challan.recoveryCaseKey)
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load challan." }, { status: 400 });
  }
}
