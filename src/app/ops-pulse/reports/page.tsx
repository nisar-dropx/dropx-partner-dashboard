import { AppShell } from "@/components/app-shell";
import { OpsReportCenter } from "@/components/ops-report-center";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { ReviewReportBuilder } from "@/components/review-report-builder";
import "./review-report.css";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";

export const dynamic = "force-dynamic";

export default async function OpsReportsPage() {
  const authorization = await requirePagePermission("ops_reports", "access");
  const companyId = requireCompanyId(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationResult.locations;
  const reviewLocations = resolveOperatingContext(locations).modeLocations;
  return <AppShell active="Reports" pageCode="ops_reports"><div className="ops-command-center ops-reports-workspace">
    <PageHead eyebrow="Ops Pulse" title="Reports" subtitle="Date-range operational downloads for permitted stations." />
    {locationResult.error ? <section className="message-panel error">{locationResult.error}</section> : null}
    {hasPermission(authorization, "performance_review", "access") ? <ReviewReportBuilder stations={reviewLocations.map((row) => ({ code: row.station_code, name: row.station_name || row.city || row.station_code, cluster: row.cluster || "Unassigned" }))}/> : null}
    <OpsReportCenter stations={locations.map((row) => ({ code: row.station_code, name: row.station_name || row.city || row.station_code, cluster: row.cluster || "Unassigned" }))}/>
  </div></AppShell>;
}
