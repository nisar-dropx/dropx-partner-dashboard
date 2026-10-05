import { documentApplies } from "@/lib/fleet/source-policy";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { type AuthorizationContext, getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { hasActiveFleetMembership } from "@/lib/fleet-control";

const bucketName = "fleet-documents";
const fallbackDocumentTypes = new Set(["FLEET_REGISTRATION", "FLEET_INSURANCE", "FLEET_PUC", "FLEET_FITNESS", "FLEET_TAX"]);
const expiryColumnByType: Record<string, string> = { FLEET_REGISTRATION: "registration_expiry", FLEET_INSURANCE: "insurance_expiry", FLEET_PUC: "puc_expiry", FLEET_FITNESS: "fitness_expiry", FLEET_TAX: "tax_expiry" };
const allowedContentTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function GET(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireDocumentPermission("access");
  if ("error" in access) return access.error;
  const { searchParams } = new URL(request.url);
  const vehicleNo = normalizeText(searchParams.get("vehicle_no")).toUpperCase();
  if (!vehicleNo) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  const vehicle = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in vehicle) return vehicle.error;

  const { data, error } = await supabaseAdmin
    .from("fleet_vehicle_documents")
    .select("document_type,file_name,content_type,file_size,expiry_date,uploaded_at,storage_path")
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo)
    .eq("is_active", true)
    .order("uploaded_at", { ascending: false });

  if (error) return mutationError(error.message);

  const latestByType = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    if (!latestByType.has(String(row.document_type))) latestByType.set(String(row.document_type), row);
  }

  const documents = Array.from(latestByType.values()).map((row) => {
    const storagePath = String(row.storage_path ?? "");
    const fileUrl = storagePath
      ? `/api/fleet/documents/download?vehicle_no=${encodeURIComponent(vehicleNo)}&document_type=${encodeURIComponent(String(row.document_type))}`
      : null;
    return {
      document_type: row.document_type,
      file_name: row.file_name,
      content_type: row.content_type,
      file_size: row.file_size,
      expiry_date: row.expiry_date,
      uploaded_at: row.uploaded_at,
      signed_url: fileUrl,
      download_url: fileUrl ? `${fileUrl}&download=1` : null
    };
  });

  return NextResponse.json({ documents });
}

export async function POST(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireDocumentPermission("edit");
  if ("error" in access) return access.error;
  const formData = await request.formData();
  const vehicleNo = normalizeText(formData.get("vehicle_no")).toUpperCase();
  const documentType = normalizeText(formData.get("document_type")).toUpperCase();
  const expiryDate = normalizeText(formData.get("expiry_date")) || null;
  const file = formData.get("file");

  if (!vehicleNo) return NextResponse.json({ error: "Vehicle number is required." }, { status: 400 });
  const documentPolicy = await loadDocumentTypePolicy(access.companyId, documentType);
  if (!documentPolicy.valid) return NextResponse.json({ error: "Valid active document type is required." }, { status: 400 });
  if (documentPolicy.requiresExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate ?? "")) return NextResponse.json({ error: "Expiry date is required for this document type." }, { status: 400 });
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Document file is required." }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Document must be 20 MB or smaller." }, { status: 400 });
  if (file.type && !allowedContentTypes.has(file.type)) return NextResponse.json({ error: "Upload a PDF, JPG, PNG or WebP file." }, { status: 400 });
  const vehicleResult = await supabaseAdmin
    .from("fleet_vehicles")
    .select("vehicle_no,station_code,ownership_type,fuel_type")
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo)
    .maybeSingle();
  if (vehicleResult.error) return mutationError(vehicleResult.error.message);
  if (!vehicleResult.data) return NextResponse.json({ error: "Vehicle not found for this company." }, { status: 404 });
  if (access.stationCodes && !access.stationCodes.includes(normalizeText(vehicleResult.data.station_code).toUpperCase())) {
    return NextResponse.json({ error: "This vehicle is not allocated to your user." }, { status: 403 });
  }

  if (!documentApplies({value:documentType,ownershipTypes:"ownershipTypes" in documentPolicy ? documentPolicy.ownershipTypes : undefined},{ownershipType:vehicleResult.data.ownership_type || "own",fuelType:vehicleResult.data.fuel_type || ""})) return NextResponse.json({error:"This document is not required for this vehicle source. Update the rule in Fleet Masters if needed."},{status:400});
  await ensureBucket();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${vehicleNo}/${documentType}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await supabaseAdmin.storage
    .from(bucketName)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false
    });

  if (uploadError) return mutationError(uploadError.message);

  const now = new Date();
  const deleteAfter = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const { error: replaceError } = await supabaseAdmin
    .from("fleet_vehicle_documents")
    .update({
      is_active: false,
      replaced_at: now.toISOString(),
      delete_after: deleteAfter
    })
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo)
    .eq("document_type", documentType)
    .eq("is_active", true);

  if (replaceError) return mutationError(replaceError.message);

  const { data, error } = await supabaseAdmin
    .from("fleet_vehicle_documents")
    .insert({
      company_id: access.companyId,
      vehicle_no: vehicleNo,
      document_type: documentType,
      file_name: file.name,
      content_type: file.type || null,
      file_size: file.size,
      storage_bucket: bucketName,
      storage_path: storagePath,
      expiry_date: expiryDate,
      is_active: true
    })
    .select()
    .single();

  if (error) {
    await supabaseAdmin.storage.from(bucketName).remove([storagePath]);
    await supabaseAdmin.from("fleet_vehicle_documents").update({ is_active: true, replaced_at: null, delete_after: null }).eq("company_id", access.companyId).eq("vehicle_no", vehicleNo).eq("document_type", documentType).eq("replaced_at", now.toISOString());
    return mutationError(error.message);
  }
  const expiryColumn = expiryColumnByType[documentType];
  if (expiryColumn) {
    await supabaseAdmin.from("fleet_vehicles").update({ [expiryColumn]: expiryDate, updated_at: now.toISOString() }).eq("company_id", access.companyId).eq("vehicle_no", vehicleNo);
  }
  const fileUrl = `/api/fleet/documents/download?vehicle_no=${encodeURIComponent(vehicleNo)}&document_type=${encodeURIComponent(documentType)}`;
  return NextResponse.json({ document: { ...data, signed_url: fileUrl, download_url: `${fileUrl}&download=1` } });
}

export async function PATCH(request: Request) {
  if (!supabaseAdmin) return setupError("Supabase service role key is not configured.");
  const access = await requireDocumentPermission("edit");
  if ("error" in access) return access.error;
  const body = await request.json();
  const vehicleNo = normalizeText(body.vehicle_no).toUpperCase();
  const documentType = normalizeText(body.document_type).toUpperCase();
  const expiryDate = normalizeText(body.expiry_date);
  if (!vehicleNo || !documentType) return NextResponse.json({ error: "Vehicle and document type are required." }, { status: 400 });
  const policy = await loadDocumentTypePolicy(access.companyId, documentType);
  if (!policy.valid) return NextResponse.json({ error: "Valid active document type is required." }, { status: 400 });
  if (policy.requiresExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return NextResponse.json({ error: "Enter a valid expiry date." }, { status: 400 });
  const scoped = await requireVehicleScope(access.companyId, vehicleNo, access.stationCodes);
  if ("error" in scoped) return scoped.error;
  const result = await supabaseAdmin.from("fleet_vehicle_documents")
    .update({ expiry_date: expiryDate || null })
    .eq("company_id", access.companyId)
    .eq("vehicle_no", vehicleNo)
    .eq("document_type", documentType)
    .eq("is_active", true)
    .select("id")
    .limit(1);
  if (result.error) return mutationError(result.error.message);
  if (!result.data?.length) return NextResponse.json({ error: "Upload the document file before setting its validity." }, { status: 409 });
  const expiryColumn = expiryColumnByType[documentType];
  if (expiryColumn) {
    const vehicleUpdate = await supabaseAdmin.from("fleet_vehicles").update({ [expiryColumn]: expiryDate || null, updated_at: new Date().toISOString() }).eq("company_id", access.companyId).eq("vehicle_no", vehicleNo);
    if (vehicleUpdate.error) return mutationError(vehicleUpdate.error.message);
  }
  return NextResponse.json({ ok: true, expiry_date: expiryDate || null });
}

async function loadDocumentTypePolicy(companyId: string, documentType: string) {
  if (!documentType) return { valid: false, requiresExpiry: false };
  if (!supabaseAdmin) return { valid: fallbackDocumentTypes.has(documentType), requiresExpiry: fallbackRequiresExpiry(documentType) };
  const { data, error } = await supabaseAdmin
    .from("document_types")
    .select("id,requires_expiry,fleet_ownership_types")
    .eq("company_id", companyId)
    .in("code", Array.from(new Set([documentType, documentType.toLowerCase()])))
    .eq("document_module", "fleet")
    .eq("is_active", true)
    .limit(1);
  if (error) return { valid: fallbackDocumentTypes.has(documentType), requiresExpiry: fallbackRequiresExpiry(documentType) };
  const configured = data?.[0];
  if (documentType === "FLEET_REGISTRATION") return { valid: Boolean(configured) || fallbackDocumentTypes.has(documentType), ownershipTypes: configured?.fleet_ownership_types, requiresExpiry: false };
  return configured ? { valid: true, ownershipTypes: configured.fleet_ownership_types, requiresExpiry: configured.requires_expiry !== false } : { valid: fallbackDocumentTypes.has(documentType), requiresExpiry: fallbackRequiresExpiry(documentType) };
}

function fallbackRequiresExpiry(documentType: string) {
  return fallbackDocumentTypes.has(documentType) && documentType !== "FLEET_REGISTRATION";
}

async function requireDocumentPermission(action: "access" | "edit") {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  const companyId = requireCompanyId(authorization);
  if (!authorization.isMasterOwner && !await hasActiveFleetMembership(companyId, authorization.userId)) return { error: NextResponse.json({ error: "You do not have access to DropX Fleet. Contact HR or your department administrator." }, { status: 403 }) };
  const allowed = action === "access"
    ? hasPermission(authorization, "fleet_vehicle_view", "access") || hasPermission(authorization, "fleet_date_view", "access") || hasPermission(authorization, "fleet", "access")
    : hasPermission(authorization, "fleet_vehicle_view", "edit") || hasPermission(authorization, "fleet_date_view", "edit") || hasPermission(authorization, "fleet", "edit");
  return allowed ? { companyId, stationCodes: await resolveFleetLocationAccess(authorization, companyId) } : { error: NextResponse.json({ error: "Fleet document permission denied." }, { status: 403 }) };
}

async function resolveFleetLocationAccess(authorization: AuthorizationContext, companyId: string) {
  if (authorization.isMasterOwner || authorization.hasAllLocationAccess) return null;
  if (!supabaseAdmin || !authorization.locationScopeIds.length) return [];
  const { data, error } = await supabaseAdmin.from("stations").select("station_code").eq("company_id", companyId).eq("is_active", true).in("id", authorization.locationScopeIds);
  if (error) return [];
  return Array.from(new Set((data ?? []).map((row) => normalizeText(row.station_code).toUpperCase()).filter(Boolean)));
}

async function requireVehicleScope(companyId: string, vehicleNo: string, stationCodes: string[] | null) {
  if (!supabaseAdmin) return { error: setupError("Supabase service role key is not configured.") };
  const { data, error } = await supabaseAdmin.from("fleet_vehicles").select("station_code").eq("company_id", companyId).eq("vehicle_no", vehicleNo).maybeSingle();
  if (error) return { error: mutationError(error.message) };
  if (!data) return { error: NextResponse.json({ error: "Vehicle not found." }, { status: 404 }) };
  if (stationCodes && !stationCodes.includes(normalizeText(data.station_code).toUpperCase())) return { error: NextResponse.json({ error: "This vehicle is not allocated to your user." }, { status: 403 }) };
  return { ok: true };
}

async function ensureBucket() {
  if (!supabaseAdmin) return;
  const { data } = await supabaseAdmin.storage.getBucket(bucketName);
  if (data) return;
  await supabaseAdmin.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 20 * 1024 * 1024
  });
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function setupError(error: string) {
  return NextResponse.json({ error }, { status: 500 });
}

function mutationError(error: string) {
  if (error.includes("fleet_vehicle_documents") || error.includes("schema cache")) {
    return NextResponse.json({ error: `${error} Run scripts/fleet_vehicle_documents_v1.sql in Supabase SQL Editor.` }, { status: 500 });
  }
  return NextResponse.json({ error }, { status: 500 });
}
