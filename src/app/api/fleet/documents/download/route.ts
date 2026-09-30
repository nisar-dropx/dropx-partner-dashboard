export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { type AuthorizationContext, getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const bucketName = "fleet-documents";

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    const companyId = requireCompanyId(authorization);
    const allowed =
      hasPermission(authorization, "fleet_vehicle_view", "access") ||
      hasPermission(authorization, "fleet_date_view", "access") ||
      hasPermission(authorization, "fleet", "access");
    if (!allowed) return NextResponse.json({ error: "Fleet document permission denied." }, { status: 403 });

    const { searchParams } = new URL(request.url);
    const vehicleNo = normalizeText(searchParams.get("vehicle_no")).toUpperCase();
    const documentType = normalizeText(searchParams.get("document_type")).toUpperCase();
    const asDownload = searchParams.get("download") === "1";
    if (!vehicleNo || !documentType) {
      return NextResponse.json({ error: "Vehicle and document type are required." }, { status: 400 });
    }
    const stationCodes = await resolveFleetLocationAccess(authorization, companyId);
    if (stationCodes) {
      const vehicle = await supabaseAdmin.from("fleet_vehicles").select("station_code").eq("company_id", companyId).eq("vehicle_no", vehicleNo).maybeSingle();
      if (vehicle.error) throw new Error(vehicle.error.message);
      if (!vehicle.data) return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
      if (!stationCodes.includes(normalizeText(vehicle.data.station_code).toUpperCase())) return NextResponse.json({ error: "This vehicle is not allocated to your user." }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("fleet_vehicle_documents")
      .select("file_name,content_type,storage_bucket,storage_path")
      .eq("company_id", companyId)
      .eq("vehicle_no", vehicleNo)
      .eq("document_type", documentType)
      .eq("is_active", true)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data?.storage_path) return NextResponse.json({ error: "Document file is not uploaded." }, { status: 404 });

    const bucket = String(data.storage_bucket || bucketName);
    const file = await supabaseAdmin.storage.from(bucket).download(String(data.storage_path));
    if (file.error) throw new Error(file.error.message);

    const filename = sanitizeFilename(String(data.file_name || `${vehicleNo}-${documentType}`));
    return new NextResponse(file.data, {
      headers: {
        "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${filename}"`,
        "Content-Type": String(data.content_type || file.data.type || "application/octet-stream"),
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load document." }, { status: 500 });
  }
}

async function resolveFleetLocationAccess(authorization: AuthorizationContext, companyId: string) {
  if (authorization.isMasterOwner || authorization.hasAllLocationAccess) return null;
  if (!supabaseAdmin || !authorization.locationScopeIds.length) return [];
  const { data, error } = await supabaseAdmin.from("stations").select("station_code").eq("company_id", companyId).eq("is_active", true).in("id", authorization.locationScopeIds);
  if (error) return [];
  return Array.from(new Set((data ?? []).map((row) => normalizeText(row.station_code).toUpperCase()).filter(Boolean)));
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function sanitizeFilename(value: string) {
  return value.replace(/[\r\n"]/g, "").trim() || "fleet-document";
}
