import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadStationAuditMaster } from "@/lib/ops-pulse/station-audits";
import { AuditMasterClient } from "./audit-master-client";

export const dynamic = "force-dynamic";

export default async function AuditMasterPage() {
  const authorization = await requirePagePermission("station_audit_master", "access");
  const master = await loadStationAuditMaster(requireCompanyId(authorization));
  return <AppShell active="Ops Masters" pageCode="station_audit_master"><div className="ops-command-center"><PageHead eyebrow="Ops Pulse master" title="Audit Master" subtitle="Configure programmes, evidence rules, checklist responses, CAPA and audit email routing without changing code." /><AuditMasterClient {...master} /></div></AppShell>;
}
