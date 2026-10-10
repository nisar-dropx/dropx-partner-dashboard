import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  loadAuditStations,
  loadAuditMasterConfiguration,
} from "@/lib/ops-pulse/station-audits";
import { loadAuditNotificationUsers } from "@/lib/ops-pulse/station-audit-recipients";
import { AirwaysMaster } from "./airways-master";
import { AuditMasterClient } from "./audit-master-client";

export const dynamic = "force-dynamic";

export default async function AuditMasterPage() {
  const authorization = await requirePagePermission(
    "station_audit_master",
    "access",
  );
  const master = await loadAuditMasterConfiguration(
    requireCompanyId(authorization),
  );
  const notificationUsers = await loadAuditNotificationUsers(
    requireCompanyId(authorization),
  );
  const stations = await loadAuditStations(
    requireCompanyId(authorization),
    authorization,
    master.programmeSettings,
  );
  return (
    <AppShell active="Ops Masters" pageCode="station_audit_master">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse master"
          title="Audit Master"
          subtitle="Configure audit roles, eligible locations, checklist responses, CAPA and email routing without changing code."
        />
        <AirwaysMaster
          options={master.options}
          stations={stations}
          canEdit={hasPermission(authorization, "station_audit_master", "edit")}
        />
        <AuditMasterClient {...master} notificationUsers={notificationUsers} />
      </div>
    </AppShell>
  );
}
