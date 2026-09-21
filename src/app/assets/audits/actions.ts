"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, max = 1000) => String(value ?? "").trim().slice(0, max);
const allowedPhotoTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function context() {
  const authorization = await requirePagePermission("asset_audits", "access");
  if (!supabaseAdmin) throw new Error("Asset audit service is unavailable.");
  return { authorization, companyId: requireCompanyId(authorization), db: supabaseAdmin };
}
async function permittedSession(value: string, current: Awaited<ReturnType<typeof context>>) {
  if (!uuid.test(value)) return null;
  const { data, error } = await current.db.from("asset_audit_sessions").select("id,location_id,status,title")
    .eq("company_id", current.companyId).eq("id", value).maybeSingle();
  if (error || !data) return null;
  if (!current.authorization.hasAllLocationAccess && data.location_id && !current.authorization.locationScopeIds.includes(data.location_id)) return null;
  return data;
}

export async function startAssetAudit(input: unknown) {
  try {
    const current = await context();
    if (!hasPermission(current.authorization, "asset_audits", "add")) throw new Error("Your role cannot start an asset audit.");
    const locationId = text((input as { location_id?: unknown })?.location_id, 36);
    if (!uuid.test(locationId)) throw new Error("Choose a location for this audit.");
    if (!current.authorization.hasAllLocationAccess && !current.authorization.locationScopeIds.includes(locationId)) throw new Error("That location is outside your audit scope.");
    const [location, number] = await Promise.all([
      current.db.from("stations").select("station_code,station_name").eq("company_id", current.companyId).eq("id", locationId).eq("is_active", true).maybeSingle(),
      current.db.rpc("asset_next_code", { p_company_id: current.companyId, p_prefix: "AUD" }),
    ]);
    if (location.error || !location.data || number.error || !number.data) throw new Error("Unable to start the audit for this location.");
    const expected = await current.db.from("assets").select("id", { count: "exact", head: true }).eq("company_id", current.companyId).eq("location_id", locationId).eq("is_active", true).neq("status", "disposed");
    if (expected.error) throw new Error("Unable to prepare the audit count.");
    const created = await current.db.from("asset_audit_sessions").insert({ company_id: current.companyId, audit_number: number.data, scope_type: "location", location_id: locationId, title: `${location.data.station_code} · ${location.data.station_name || "Asset audit"}`, status: "in_progress", expected_count: expected.count || 0, started_by: current.authorization.userId, started_at: new Date().toISOString(), created_by: current.authorization.userId }).select("id").single();
    if (created.error) throw new Error("Unable to create this audit session.");
    revalidatePath("/assets/audits");
    return { ok: true as const, id: created.data.id };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Unable to start the audit." }; }
}

export async function scanAssetAudit(input: unknown) {
  try {
    const current = await context();
    if (!hasPermission(current.authorization, "asset_audits", "add")) throw new Error("Your role cannot record audit scans.");
    const item = input as Record<string, unknown>;
    const session = await permittedSession(text(item.session_id, 36), current);
    if (!session || session.status !== "in_progress") throw new Error("This audit is not available for scanning.");
    const code = text(item.scanned_code, 80); const condition = text(item.observed_condition, 20) || "good";
    if (!code) throw new Error("Scan or enter an asset code.");
    if (!["good", "fair", "damaged", "unusable"].includes(condition)) throw new Error("Choose a valid observed condition.");
    const [byAssetCode, byBarcode] = await Promise.all([
      current.db.from("assets").select("id,location_id").eq("company_id", current.companyId).eq("asset_code", code).maybeSingle(),
      current.db.from("assets").select("id,location_id").eq("company_id", current.companyId).eq("barcode_value", code).maybeSingle(),
    ]);
    const asset = byAssetCode.data ?? byBarcode.data;
    if (byAssetCode.error || byBarcode.error || !asset) throw new Error("This code is not in the asset register.");
    const result = await current.db.rpc("asset_record_audit_item", { p_company_id: current.companyId, p_session_id: session.id, p_scanned_code: code, p_capture_method: "scan", p_observed_location_id: session.location_id, p_observed_status: null, p_observed_condition: condition, p_manual_reason: null, p_notes: text(item.notes, 1000) || null, p_actor: current.authorization.userId, p_actor_name: current.authorization.fullName || current.authorization.email || "Asset auditor" });
    if (result.error) throw new Error(result.error.message.includes("not found") ? "This code is not in the asset register." : "Unable to record this scan.");
    revalidatePath("/assets/audits"); revalidatePath("/master/assets");
    return { ok: true as const, id: String(result.data), assetId: String(asset.id) };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Unable to record the scan." }; }
}

export async function attachAuditPhoto(form: FormData) {
  try {
    const current = await context();
    if (!hasPermission(current.authorization, "asset_audits", "add")) throw new Error("Your role cannot add audit photo evidence.");
    const session = await permittedSession(text(form.get("session_id"), 36), current);
    const assetId = text(form.get("asset_id"), 36); const notes = text(form.get("notes"), 1000); const file = form.get("photo");
    if (!session || !uuid.test(assetId) || !(file instanceof File)) throw new Error("Save a valid scan and choose its photo.");
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error("Choose a photo up to 10 MB.");
    const auditItem = await current.db.from("asset_audit_items").select("id").eq("company_id", current.companyId).eq("session_id", session.id).eq("asset_id", assetId).order("observed_at", { ascending: false }).limit(1).maybeSingle();
    if (auditItem.error || !auditItem.data) throw new Error("The photo must be attached immediately after its audit scan.");
    const extension = file.name.split(".").pop()?.toLowerCase() || ""; const contentType = allowedPhotoTypes[extension];
    if (!contentType || (file.type && file.type !== "application/octet-stream" && file.type !== contentType)) throw new Error("Upload a JPG, PNG or WEBP photo.");
    const bytes = Buffer.from(await file.arrayBuffer()); const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
    const valid = (contentType === "image/jpeg" && starts([255, 216, 255])) || (contentType === "image/png" && starts([137, 80, 78, 71, 13, 10, 26, 10])) || (contentType === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
    if (!valid) throw new Error("The uploaded file content does not match a supported photo format.");
    const id = randomUUID(); const path = `${current.companyId}/${assetId}/${id}.${extension === "jpeg" ? "jpg" : extension}`;
    const upload = await current.db.storage.from("asset-evidence").upload(path, bytes, { contentType, upsert: false, cacheControl: "0" });
    if (upload.error) throw new Error("The audit photo could not be uploaded.");
    const saved = await current.db.from("asset_attachments").insert({ id, company_id: current.companyId, asset_id: assetId, attachment_type: "photo", file_name: file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180), content_type: contentType, file_size: bytes.length, storage_bucket: "asset-evidence", storage_path: path, uploaded_by: current.authorization.userId });
    if (saved.error) { await current.db.storage.from("asset-evidence").remove([path]); throw new Error("The audit photo could not be linked to the asset."); }
    await current.db.from("asset_events").insert({ company_id: current.companyId, asset_id: assetId, audit_session_id: session.id, event_type: "audit_photo_added", notes: notes || `Audit photo added in ${session.title}`, actor_user_id: current.authorization.userId, actor_name: current.authorization.fullName || current.authorization.email || "Asset auditor" });
    revalidatePath("/assets/audits"); revalidatePath("/master/assets");
    return { ok: true as const };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Unable to attach the audit photo." }; }
}

export async function completeAssetAudit(sessionId: string) {
  try {
    const current = await context();
    if (!hasPermission(current.authorization, "asset_audits", "edit")) throw new Error("Your role cannot complete an asset audit.");
    const session = await permittedSession(sessionId, current);
    if (!session) throw new Error("Audit session not found.");
    const result = await current.db.rpc("asset_complete_audit", { p_company_id: current.companyId, p_session_id: session.id, p_actor: current.authorization.userId });
    if (result.error) throw new Error("Unable to complete this audit.");
    revalidatePath("/assets/audits"); return { ok: true as const };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Unable to complete the audit." }; }
}
