import { AppShell } from "@/components/app-shell";
import { OpsReportCenter } from "@/components/ops-report-center";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";

export const dynamic = "force-dynamic";

export default async function OpsReportsPage() {
  const authorization = await requirePagePermission("cod_reports", "access");
  const companyId = requireCompanyId(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationResult.locations;
  return <AppShell active="Reports" pageCode="cod_reports"><div className="ops-command-center ops-reports-workspace">
    <PageHead eyebrow="Ops Pulse" title="Reports" subtitle="Date-range operational downloads for permitted stations." />
    {locationResult.error ? <section className="message-panel error">{locationResult.error}</section> : null}
    <OpsReportCenter stations={locations.map((row) => ({ code: row.station_code, name: row.station_name || row.city || row.station_code, cluster: row.cluster || "Unassigned" }))}/>
  </div></AppShell>;
}
