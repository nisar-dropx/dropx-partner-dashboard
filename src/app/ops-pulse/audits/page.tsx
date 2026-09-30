import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canManageStationAudits, loadStationAuditWorkspace, ymdInKolkata } from "@/lib/ops-pulse/station-audits";
import { AuditWorkspace } from "./audit-workspace";

export const dynamic = "force-dynamic";

function dateRange(value: string) {
  const date = new Date(`${value}T12:00:00Z`); const from = new Date(date); const to = new Date(date);
  from.setUTCDate(from.getUTCDate() - 14); to.setUTCDate(to.getUTCDate() + 45);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function StationAuditsPage({ searchParams }: { searchParams?: { audit?: string; month?: string } }) {
  const authorization = await requirePagePermission("station_audits", "access"); const companyId = requireCompanyId(authorization);
  const base = /^\d{4}-\d{2}$/.test(String(searchParams?.month ?? "")) ? `${searchParams!.month}-15` : ymdInKolkata(); const range = dateRange(base);
  const workspace = await loadStationAuditWorkspace(companyId, authorization, range.from, range.to);
  const canManage = canManageStationAudits(authorization); const canRespond = hasPermission(authorization, "station_audits", "add") || hasPermission(authorization, "station_audits", "edit");
  return <AppShell active="Operations" pageCode="station_audits"><div className="ops-command-center"><PageHead eyebrow="Ops assurance programme" title="Station audits" subtitle="Schedule and complete virtual COD and physical station audits, reconcile evidence, and close CAPA with the station." action={<><Link className="button secondary compact" href={`/api/ops-pulse/audits/export?from=${range.from}&to=${range.to}`}>Download Excel</Link>{hasPermission(authorization, "station_audit_master", "access") ? <Link className="button secondary compact" href="/master/audits">Audit Master</Link> : null}</>} /><AuditWorkspace workspace={workspace} canManage={canManage} canRespond={canRespond} focusAuditId={searchParams?.audit} /></div></AppShell>;
}
