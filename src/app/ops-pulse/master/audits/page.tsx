import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadAuditMasterConfiguration } from "@/lib/ops-pulse/station-audits";
import { AuditMasterClient } from "./audit-master-client";

export const dynamic = "force-dynamic";

export default async function AuditMasterPage() {
  const authorization = await requirePagePermission("station_audit_master", "access");
  const master = await loadAuditMasterConfiguration(requireCompanyId(authorization));
  return <AppShell active="Ops Masters" pageCode="station_audit_master"><div className="ops-command-center"><PageHead eyebrow="Ops Pulse master" title="Audit Master" subtitle="Configure audit roles, eligible locations, checklist responses, CAPA and email routing without changing code." /><AuditMasterClient {...master} /></div></AppShell>;
}
