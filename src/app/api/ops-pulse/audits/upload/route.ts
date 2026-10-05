import { randomUUID } from "node:crypto";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  canManageStationAudits,
  canRespondToStationAudits,
  canUseStationAuditLocation,
  isStationAuditEligible,
  loadStationAuditMaster,
} from "@/lib/ops-pulse/station-audits";
import { isMyAudit } from "@/lib/ops-pulse/station-audit-planning";
export const dynamic = "force-dynamic";
const bucket = "ops-pulse-documents";
const maxSize = 30 * 1024 * 1024;
const proofTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
export async function POST(request: Request) {
  try {
    const auth = await getAuthorization();
    if (
      !auth?.companyId ||
      auth.readOnly ||
      !hasPermission(auth, "station_audits", "access")
    )
      return Response.json(
        { error: "Audit upload access denied." },
        { status: 403 },
      );
    if (!supabaseAdmin) throw new Error("Storage unavailable.");
    const input = await request.json();
    const master = await loadStationAuditMaster(auth.companyId);
    const result = await supabaseAdmin
      .from("ops_station_audits")
      .select(
        "id,location_id,assigned_to,assignment_verified,status_code,started_at,completed_at,station_response_status,stations(location_model_id,is_ho)",
      )
      .eq("company_id", auth.companyId)
      .eq("id", String(input.auditId))
      .is("deleted_at", null)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    const audit = result.data;
    const joined = audit?.stations;
    const station = Array.isArray(joined) ? joined[0] : joined;
    if (
      !audit ||
      !station ||
      !canUseStationAuditLocation(auth, audit.location_id) ||
      !isStationAuditEligible(
        {
          id: audit.location_id,
          location_model_id: station.location_model_id,
          is_ho: station.is_ho,
        },
        master.programmeSettings,
      )
    )
      return Response.json(
        { error: "Audit unavailable in your location scope." },
        { status: 404 },
      );
    const performer =
      hasPermission(auth, "station_audits", "edit") &&
      canManageStationAudits(auth, master.programmeSettings) &&
      isMyAudit(audit, auth.userId) &&
      Boolean(audit.started_at) &&
      ["in_progress", "under_review", "awaiting_station_response"].includes(
        audit.status_code,
      );
    const responder =
      canRespondToStationAudits(auth, master.programmeSettings) &&
      Boolean(audit.completed_at) &&
      audit.status_code === "awaiting_station_response" &&
      audit.station_response_status === "requested";
    if (!performer && !responder)
      return Response.json(
        {
          error:
            "Only the assigned auditor or the station responding to findings may attach proof.",
        },
        { status: 403 },
      );
    const prefix = `${auth.companyId}/station-audits/${audit.id}/proof/${auth.userId}/`;
    if (input.phase === "prepare") {
      if (!proofTypes.has(String(input.contentType)))
        throw new Error("Use a JPG, PNG, WEBP, HEIC or PDF proof.");
      const size = Number(input.size);
      const fileName = String(input.fileName || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120);
      if (!fileName || !Number.isFinite(size) || size <= 0 || size > maxSize)
        throw new Error("Choose a proof file up to 30 MB.");
      const path = `${prefix}${randomUUID()}-${fileName}`;
      let signed = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUploadUrl(path);
      if (signed.error?.message.toLowerCase().includes("bucket")) {
        const created = await supabaseAdmin.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: maxSize,
        });
        if (
          created.error &&
          !created.error.message.toLowerCase().includes("already exists")
        )
          throw new Error(created.error.message);
        signed = await supabaseAdmin.storage
          .from(bucket)
          .createSignedUploadUrl(path);
      }
      if (signed.error) throw new Error(signed.error.message);
      return Response.json({ bucket, path, token: signed.data.token });
    }
    if (input.phase !== "complete")
      throw new Error("Invalid upload operation.");
    const path = String(input.path || "");
    const name = path.slice(prefix.length);
    if (
      !path.startsWith(prefix) ||
      !/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[a-zA-Z0-9._-]+$/.test(
        name,
      )
    )
      throw new Error("Invalid proof reference.");
    const object = await supabaseAdmin.storage
      .from(bucket)
      .list(prefix.slice(0, -1), { search: name, limit: 10 });
    if (object.error) throw new Error(object.error.message);
    const file = object.data.find((f) => f.name === name);
    if (!file || !file.metadata?.size || Number(file.metadata.size) > maxSize)
      throw new Error("The proof upload is incomplete. Please try again.");
    if (!proofTypes.has(String(file.metadata.mimetype)))
      throw new Error("Use a JPG, PNG, WEBP, HEIC or PDF proof.");
    const kind =
      performer && ["erp_screenshot", "cash_variance"].includes(input.kind)
        ? input.kind
        : "document";
    const saved = await supabaseAdmin.from("ops_station_audit_evidence").upsert(
      {
        id: name.slice(0, 36),
        company_id: auth.companyId,
        audit_id: audit.id,
        evidence_kind_code: kind,
        file_name: name.slice(37),
        media_url: `storage://${bucket}/${path}`,
        caption:
          kind === "erp_screenshot"
            ? "ERP expected cash balance"
            : responder
              ? "Station response"
              : null,
        uploaded_by: auth.userId,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (saved.error) throw new Error(saved.error.message);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to attach proof.",
      },
      { status: 400 },
    );
  }
}
