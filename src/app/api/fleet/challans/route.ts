import { withFleetSystemLog } from "@/lib/fleet/system-log";
import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { fleetChallanDriveConfigured, mirrorChallanEvidenceToDrive, uploadFleetChallanDriveFile } from "@/lib/fleet/challan-drive";
import { listFleetChallans, mapFleetChallan, resolveFleetStationCodes } from "@/lib/fleet/challans";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowedMime = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

async function requireChallanAccess(action: "access" | "edit" | "add") {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  if (!authorization.isMasterOwner && !(await hasActiveFleetMembership(companyId, authorization.userId))) {
    return { error: NextResponse.json({ error: "You do not have access to DropX Fleet." }, { status: 403 }) };
  }
  const codes = ["fleet_vehicle_view", "fleet_date_view", "fleet_action_center"] as const;
  const allowed = authorization.isMasterOwner || codes.some((code) => hasPermission(authorization, code, action === "access" ? "access" : action === "add" ? "add" : "edit") || (action !== "access" && hasPermission(authorization, code, "edit")));
  if (!allowed && action === "access") {
    const readOk = codes.some((code) => hasPermission(authorization, code, "access"));
    if (!readOk) return { error: NextResponse.json({ error: "Fleet challan permission denied." }, { status: 403 }) };
  } else if (!allowed) {
    return { error: NextResponse.json({ error: "Fleet challan edit permission denied." }, { status: 403 }) };
  }
  if (authorization.readOnly && action !== "access") {
    return { error: NextResponse.json({ error: "Read-only preview cannot change challans." }, { status: 403 }) };
  }
  return {
    authorization,
    companyId,
    stationCodes: await resolveFleetStationCodes(authorization, companyId),
    actorName: authorization.fullName || authorization.email || "Fleet user"
  };
}

export async function GET() {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
    const access = await requireChallanAccess("access");
    if ("error" in access) return access.error;
    const challans = await listFleetChallans(access.companyId, access.stationCodes);
    return NextResponse.json({
      challans,
      driveConfigured: fleetChallanDriveConfigured(),
      canEdit: !access.authorization.readOnly && (
        access.authorization.isMasterOwner ||
        hasPermission(access.authorization, "fleet_vehicle_view", "edit") ||
        hasPermission(access.authorization, "fleet_date_view", "edit") ||
        hasPermission(access.authorization, "fleet_action_center", "edit")
      ),
      canAdd: !access.authorization.readOnly && (
        access.authorization.isMasterOwner ||
        hasPermission(access.authorization, "fleet_vehicle_view", "add") ||
        hasPermission(access.authorization, "fleet_vehicle_view", "edit") ||
        hasPermission(access.authorization, "fleet_date_view", "edit")
      )
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load challans." }, { status: 400 });
  }
}

async function handlePOST(request: Request) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
    const access = await requireChallanAccess("add");
    if ("error" in access) return access.error;

    const contentType = request.headers.get("content-type") || "";
    let payload: Record<string, unknown> = {};
    let evidenceFile: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      payload = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, unknown>;
      const file = form.get("evidence");
      evidenceFile = file instanceof File && file.size ? file : null;
    } else {
      payload = (await request.json()) as Record<string, unknown>;
    }

    const vehicleNo = String(payload.vehicleNo || "").trim().toUpperCase().replace(/\s+/g, "");
    const challanNumber = String(payload.challanNumber || "").trim().toUpperCase();
    const amount = Number(payload.amount);
    if (!vehicleNo || !challanNumber || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Vehicle number, challan number and amount are required." }, { status: 400 });
    }

    if (access.stationCodes) {
      const vehicle = await supabaseAdmin
        .from("fleet_vehicles")
        .select("station_code")
        .eq("company_id", access.companyId)
        .eq("vehicle_no", vehicleNo)
        .maybeSingle();
      if (vehicle.error) throw new Error(vehicle.error.message);
      if (!vehicle.data) return NextResponse.json({ error: "Vehicle was not found in Fleet." }, { status: 404 });
      if (!access.stationCodes.includes(String(vehicle.data.station_code || "").trim().toUpperCase())) {
        return NextResponse.json({ error: "This vehicle is outside your assigned stations." }, { status: 403 });
      }
    }

    let driveFileId = String(payload.driveFileId || "").trim();
    let driveViewUrl = String(payload.driveViewUrl || "").trim();
    let driveMimeType = String(payload.driveMimeType || "").trim();
    let evidenceUrl = String(payload.evidenceUrl || "").trim();

    if (evidenceFile) {
      if (evidenceFile.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Evidence must be 20 MB or smaller." }, { status: 400 });
      if (evidenceFile.type && !allowedMime.has(evidenceFile.type)) {
        return NextResponse.json({ error: "Upload a PDF, JPG, PNG or WebP file." }, { status: 400 });
      }
      if (!fleetChallanDriveConfigured()) {
        return NextResponse.json({ error: "Google Drive is not configured for challan evidence. Set FLEET_CHALLAN_DRIVE_FOLDER_ID and GOOGLE_OAUTH_*." }, { status: 400 });
      }
      const uploaded = await uploadFleetChallanDriveFile({
        name: `${vehicleNo}_${challanNumber}_${evidenceFile.name}`.slice(0, 180),
        mime: evidenceFile.type || "application/pdf",
        bytes: new Uint8Array(await evidenceFile.arrayBuffer())
      });
      driveFileId = uploaded.id;
      driveViewUrl = uploaded.webViewLink;
      driveMimeType = uploaded.mimeType;
      evidenceUrl = uploaded.webViewLink;
    } else if (evidenceUrl && !driveFileId && fleetChallanDriveConfigured()) {
      const mirrored = await mirrorChallanEvidenceToDrive({
        sourceUrl: evidenceUrl,
        fileName: `${vehicleNo}_${challanNumber}.pdf`
      });
      if (mirrored) {
        driveFileId = mirrored.id;
        driveViewUrl = mirrored.webViewLink;
        driveMimeType = mirrored.mimeType;
        evidenceUrl = mirrored.webViewLink;
      }
    }

    const result = await supabaseAdmin.rpc("fleet_challan_upsert_v1", {
      p_company: access.companyId,
      p_user: access.authorization.userId,
      p_data: {
        vehicleNo,
        challanNumber,
        amount,
        offenseDate: payload.offenseDate || null,
        offenseAt: payload.offenseAt || null,
        offenseDescription: payload.offenseDescription || "Traffic challan",
        issuingAuthority: payload.issuingAuthority || "unknown",
        stateCode: payload.stateCode || "",
        source: "manual",
        evidenceUrl: evidenceUrl || null,
        driveFileId: driveFileId || null,
        driveViewUrl: driveViewUrl || null,
        driveMimeType: driveMimeType || null,
        actorName: access.actorName,
        rawPayload: payload.rawPayload && typeof payload.rawPayload === "object" ? payload.rawPayload : {}
      }
    });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ ok: true, challan: mapFleetChallan(result.data) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save challan." }, { status: 400 });
  }
}

export const POST = withFleetSystemLog(handlePOST);
