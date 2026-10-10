import { canDeleteStationAudit } from "@/lib/ops-pulse/station-audit-people";
import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canManageStationAudits,
  canUseStationAuditLocation,
  canRespondToStationAudits,
  loadStationAuditMaster,
  loadStationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import {
  auditDay,
  auditMonthRange,
  validAuditDate,
  stationCanSeeAudit,
} from "@/lib/ops-pulse/station-audit-planning";
import { loadAuditClusters } from "@/lib/ops-pulse/station-audit-clusters";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { auditReportRangeError } from "@/lib/ops-pulse/station-audit-progress";
import { AuditWorkspace } from "./audit-workspace";

export const dynamic = "force-dynamic";
export default async function StationAuditsPage({
  searchParams,
}: {
  searchParams?: { audit?: string; month?: string; from?: string; to?: string; view?: string };
}) {
  const authorization = await requirePagePermission("station_audits", "access");
  const companyId = requireCompanyId(authorization);
  let month = validAuditDate(`${searchParams?.month}-01`)
    ? searchParams!.month!
    : auditDay().slice(0, 7);
  if (searchParams?.from && searchParams?.to && !auditReportRangeError(searchParams.from, searchParams.to)) month = searchParams.from.slice(0, 7);
  const master = await loadStationAuditMaster(companyId);
  const canManage = canManageStationAudits(authorization, master.programmeSettings);
  // Completion emails may link to an audit outside the current calendar month.
  if (searchParams?.audit && supabaseAdmin) {
    const focused = await supabaseAdmin.from("ops_station_audits")
      .select("location_id,scheduled_for,status_code,completed_at,station_response_status")
      .eq("company_id", companyId).eq("id", searchParams.audit).is("deleted_at", null).maybeSingle();
    if (focused.data && canUseStationAuditLocation(authorization, focused.data.location_id)
      && (canManage || stationCanSeeAudit(focused.data))) {
      month = auditDay(focused.data.scheduled_for).slice(0, 7);
    }
  }
  const range = auditMonthRange(month);
  const reportError = searchParams?.from || searchParams?.to
    ? auditReportRangeError(searchParams?.from || "", searchParams?.to || "") : "";
  const reportRange = !reportError && searchParams?.from && searchParams?.to
    ? { from: searchParams.from, to: searchParams.to } : { from: range.from, to: range.to };
  const workspace = await loadStationAuditWorkspace(
    companyId,
    authorization,
    reportRange.from < range.calendarFrom ? reportRange.from : range.calendarFrom,
    reportRange.to > range.calendarTo ? reportRange.to : range.calendarTo,
    !canManage,
    master,
  );
  const clusters = canManage
    ? await loadAuditClusters(companyId, workspace.stations)
    : { byStation: {}, options: [] };
  return (
    <AppShell active="Operations" pageCode="station_audits">
      <div className="ops-command-center">
        <AuditWorkspace
          workspace={workspace}
          clusters={clusters}
          canManage={canManage}
          canSchedule={
            canManage && hasPermission(authorization, "station_audits", "add")
          }
          canEdit={
            canManage && hasPermission(authorization, "station_audits", "edit")
          }
          canRespond={
            canRespondToStationAudits(
              authorization,
              master.programmeSettings,
            ) && !authorization.readOnly
          }
          stationOnly={!canManage}
          focusAuditId={searchParams?.audit}
          month={month}
          reportRange={reportRange}
          reportError={reportError}
          viewerName={
            authorization.fullName || authorization.email || "Current user"
          }
          viewerRole={authorization.roleName || "Authorized user"}
          viewerId={authorization.userId}
          canDelete={canDeleteStationAudit(authorization)}
          canViewMaster={hasPermission(
            authorization,
            "station_audit_master",
            "access",
          )}
          readOnly={Boolean(authorization.readOnly)}
        />
      </div>
    </AppShell>
  );
}
