import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canManageStationAudits,
  canUseStationAuditLocation,
  isStationAuditEligible,
  loadStationAuditMaster,
} from "@/lib/ops-pulse/station-audits";
import { stationCanSeeAudit } from "@/lib/ops-pulse/station-audit-planning";
import { buildStationAuditReport } from "@/lib/ops-pulse/station-audit-report-data";
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
  const found = await supabaseAdmin
    .from("ops_station_audits")
    .select("*,ops_audit_types(*),stations(*)")
    .eq("company_id", companyId)
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();
  const audit = found.data;
  if (
    found.error ||
    !audit ||
    !audit.completed_at ||
    !canUseStationAuditLocation(authorization, audit.location_id) ||
    !isStationAuditEligible(
      {
        id: audit.location_id,
        location_model_id: audit.stations?.location_model_id ?? null,
        is_ho: audit.stations?.is_ho === true,
      },
      master.programmeSettings,
    ) ||
    (!canManage && !stationCanSeeAudit(audit))
  )
    return Response.json(
      { error: "Report is unavailable in your station scope." },
      { status: 404 },
    );
  try {
    const { pdf } = await buildStationAuditReport(companyId, audit);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${audit.audit_number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      { error: "The audit report could not be generated. Please retry." },
      { status: 500 },
    );
  }
}
export const maxDuration = 60;
