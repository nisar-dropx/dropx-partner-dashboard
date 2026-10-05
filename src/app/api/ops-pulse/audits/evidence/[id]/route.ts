import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canManageStationAudits,
  canUseStationAuditLocation,
  isStationAuditEligible,
  loadStationAuditMaster,
} from "@/lib/ops-pulse/station-audits";
import { stationCanSeeAudit } from "@/lib/ops-pulse/station-audit-planning";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const authorization = await getAuthorization();
  if (
    !authorization ||
    !hasPermission(authorization, "station_audits", "access")
  )
    return Response.json(
      { error: "Audit evidence access denied." },
      { status: 403 },
    );
  if (!supabaseAdmin)
    return Response.json({ error: "Database unavailable." }, { status: 500 });
  const companyId = requireCompanyId(authorization);
  const master = await loadStationAuditMaster(companyId);
  const canManage = canManageStationAudits(
    authorization,
    master.programmeSettings,
  );
  const evidence = await supabaseAdmin
    .from("ops_station_audit_evidence")
    .select(
      "id,file_name,media_url,ops_station_audits!inner(deleted_at,location_id,status_code,completed_at,station_response_status,stations(location_model_id,is_ho))",
    )
    .eq("company_id", companyId)
    .eq("id", params.id)
    .maybeSingle();
  if (evidence.error)
    return Response.json({ error: evidence.error.message }, { status: 500 });
  const row: any = evidence.data;
  const audit = Array.isArray(row?.ops_station_audits)
    ? row.ops_station_audits[0]
    : row?.ops_station_audits;
  const station = Array.isArray(audit?.stations)
    ? audit.stations[0]
    : audit?.stations;
  if (
    !row ||
    !audit || audit.deleted_at ||
    !station ||
    !canUseStationAuditLocation(authorization, audit.location_id) ||
    !isStationAuditEligible(
      {
        id: audit.location_id,
        location_model_id: station.location_model_id ?? null,
        is_ho: station.is_ho === true,
      },
      master.programmeSettings,
    ) ||
    (!canManage && !stationCanSeeAudit(audit))
  )
    return Response.json(
      { error: "Evidence is unavailable in your station scope." },
      { status: 404 },
    );
  if (!String(row.media_url).startsWith("storage://"))
    return Response.redirect(row.media_url);
  const match = String(row.media_url).match(/^storage:\/\/([^/]+)\/(.+)$/);
  if (!match)
    return Response.json(
      { error: "Evidence reference is invalid." },
      { status: 400 },
    );
  const file = await supabaseAdmin.storage.from(match[1]).download(match[2]);
  if (file.error || !file.data)
    return Response.json(
      { error: file.error?.message ?? "Evidence file is unavailable." },
      { status: 404 },
    );
  return new Response(await file.data.arrayBuffer(), {
    headers: {
      "Content-Type": file.data.type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${String(row.file_name || "audit-evidence").replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
