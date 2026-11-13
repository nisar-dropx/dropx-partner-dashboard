import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  fleetChallanDriveConfigured,
  mirrorChallanEvidenceToDrive,
  uploadInlineChallanEvidenceToDrive
} from "@/lib/fleet/challan-drive";
import { mapFleetChallan } from "@/lib/fleet/challans";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.FLEET_CHALLAN_INGEST_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const given = Buffer.from(header);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

type IngestRow = {
  companyId?: string;
  vehicleNo?: string;
  challanNumber?: string;
  amount?: number | string;
  offenseDate?: string;
  offenseAt?: string;
  offenseDescription?: string;
  issuingAuthority?: string;
  stateCode?: string;
  source?: string;
  evidenceUrl?: string;
  evidenceBase64?: string;
  evidenceExt?: string;
  portalStatus?: string;
  rawPayload?: Record<string, unknown>;
};

/** Authorized webhook / provider ingest. Mirrors evidence to Drive when configured. */
export async function POST(request: Request) {
  try {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });

    const body = await request.json();
    const rows: IngestRow[] = Array.isArray(body?.challans) ? body.challans : [body];
    if (!rows.length || rows.length > 200) {
      return NextResponse.json({ error: "Send 1–200 challan rows." }, { status: 400 });
    }

    const defaultCompany = String(body?.companyId || process.env.FLEET_DEFAULT_COMPANY_ID || "").trim();
    const results: Array<{ challanNumber: string; ok: boolean; id?: string; error?: string }> = [];

    for (const row of rows) {
      const challanNumber = String(row.challanNumber || "").trim().toUpperCase();
      const vehicleNo = String(row.vehicleNo || "").trim().toUpperCase().replace(/\s+/g, "");
      try {
        const companyId = String(row.companyId || defaultCompany).trim();
        if (!companyId) throw new Error("companyId is required.");
        if (!challanNumber || !vehicleNo) throw new Error("vehicleNo and challanNumber are required.");
        const amount = Number(row.amount);
        if (!Number.isFinite(amount) || amount < 0) throw new Error("amount is required.");

        let driveFileId = "";
        let driveViewUrl = "";
        let driveMimeType = "";
        let evidenceUrl = String(row.evidenceUrl || "").trim();
        const evidenceBase64 = String(row.evidenceBase64 || "").trim();
        if (fleetChallanDriveConfigured() && (evidenceUrl || evidenceBase64)) {
          const mirrored = evidenceBase64
            ? await uploadInlineChallanEvidenceToDrive({
                base64: evidenceBase64,
                fileExt: String(row.evidenceExt || "png"),
                fileName: `${vehicleNo}_${challanNumber}`
              })
            : await mirrorChallanEvidenceToDrive({
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
          p_company: companyId,
          p_user: null,
          p_data: {
            vehicleNo,
            challanNumber,
            amount,
            offenseDate: row.offenseDate || null,
            offenseAt: row.offenseAt || null,
            offenseDescription: row.offenseDescription || "Traffic challan",
            // Authority is a coded enum (mvd/parivahan/…); NIC/Parivahan is the
            // system of record, shown with a friendly label in the UI.
            issuingAuthority: row.issuingAuthority || "parivahan",
            stateCode: row.stateCode || "",
            source: String(row.source || "").trim() || "ingest",
            evidenceUrl: evidenceUrl || null,
            driveFileId: driveFileId || null,
            driveViewUrl: driveViewUrl || null,
            driveMimeType: driveMimeType || null,
            portalStatus: row.portalStatus || null,
            actorName: "Challan ingest",
            rawPayload: row.rawPayload || row
          }
        });
        if (result.error) throw new Error(result.error.message);
        results.push({ challanNumber, ok: true, id: mapFleetChallan(result.data).id });
      } catch (error) {
        results.push({
          challanNumber: challanNumber || "unknown",
          ok: false,
          error: error instanceof Error ? error.message : "Ingest failed."
        });
      }
    }

    return NextResponse.json({
      ok: results.every((row) => row.ok),
      upserted: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      results
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ingest failed." }, { status: 400 });
  }
}
