import { withFleetSystemLog } from "@/lib/fleet/system-log";
import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { mapFleetChallan, resolveFleetStationCodes } from "@/lib/fleet/challans";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handlePOST(request: Request) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    if (authorization.readOnly) return NextResponse.json({ error: "Read-only preview cannot change challans." }, { status: 403 });
    const companyId = requireCompanyId(authorization);
    if (!authorization.isMasterOwner && !(await hasActiveFleetMembership(companyId, authorization.userId))) {
      return NextResponse.json({ error: "You do not have access to DropX Fleet." }, { status: 403 });
    }
    const canEdit =
      authorization.isMasterOwner ||
      hasPermission(authorization, "fleet_vehicle_view", "edit") ||
      hasPermission(authorization, "fleet_date_view", "edit") ||
      hasPermission(authorization, "fleet_action_center", "edit");
    if (!canEdit) return NextResponse.json({ error: "Fleet challan edit permission denied." }, { status: 403 });

    const id = new URL(request.url).pathname.split("/").filter(Boolean).at(-2) || "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Challan was not found." }, { status: 404 });
    const body = await request.json();
    const status = String(body.status || "").trim();
    const note = String(body.note || "").trim();
    const stationCodes = await resolveFleetStationCodes(authorization, companyId);
    if (stationCodes) {
      const existing = await supabaseAdmin
        .from("fleet_challans")
        .select("station_code")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return NextResponse.json({ error: "Challan was not found." }, { status: 404 });
      if (!stationCodes.includes(String(existing.data.station_code || "").trim().toUpperCase())) {
        return NextResponse.json({ error: "This challan is outside your assigned stations." }, { status: 403 });
      }
    }

    const result = await supabaseAdmin.rpc("fleet_challan_set_status_v1", {
      p_company: companyId,
      p_challan: id,
      p_user: authorization.userId,
      p_name: authorization.fullName || authorization.email || "Fleet user",
      p_status: status,
      p_note: note || null
    });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ ok: true, challan: mapFleetChallan(result.data) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update challan status." }, { status: 400 });
  }
}

export const POST = withFleetSystemLog(handlePOST);
