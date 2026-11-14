import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { resolveFleetStationCodes } from "@/lib/fleet/challans";
import { downloadFleetChallanDriveFile } from "@/lib/fleet/challan-drive";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stream a challan's Drive evidence to any authenticated org member with Fleet
 * access, scoped to their stations. The Drive file itself stays private — only
 * this route (holding the server OAuth token) can read it, so evidence is never
 * exposed on the public internet.
 */
export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    const companyId = requireCompanyId(authorization);
    if (!authorization.isMasterOwner && !(await hasActiveFleetMembership(companyId, authorization.userId))) {
      return NextResponse.json({ error: "You do not have access to DropX Fleet." }, { status: 403 });
    }
    const canView =
      authorization.isMasterOwner ||
      hasPermission(authorization, "fleet_vehicle_view", "view") ||
      hasPermission(authorization, "fleet_date_view", "view") ||
      hasPermission(authorization, "fleet_action_center", "view");
    if (!canView) return NextResponse.json({ error: "Fleet challan view permission denied." }, { status: 403 });

    const url = new URL(request.url);
    const id = url.pathname.split("/").filter(Boolean).at(-2) || "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Challan was not found." }, { status: 404 });

    const existing = await supabaseAdmin
      .from("fleet_challans")
      .select("station_code,drive_file_id")
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) return NextResponse.json({ error: "Challan was not found." }, { status: 404 });

    const stationCodes = await resolveFleetStationCodes(authorization, companyId);
    if (stationCodes && !stationCodes.includes(String(existing.data.station_code || "").trim().toUpperCase())) {
      return NextResponse.json({ error: "This challan is outside your assigned stations." }, { status: 403 });
    }

    const fileId = String(existing.data.drive_file_id || "").trim();
    if (!fileId) return NextResponse.json({ error: "No Drive evidence is attached to this challan." }, { status: 404 });

    const file = await downloadFleetChallanDriveFile(fileId);
    const download = url.searchParams.get("download") === "1";
    const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    const disposition = `${download ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": disposition,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load evidence." },
      { status: 400 }
    );
  }
}
