import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import {
  context,
  workspace,
  readAudit,
  proofs,
} from "@/lib/ops-pulse/store-audits/server";
import {
  canInspect,
  canRespond,
  isManager,
} from "@/lib/ops-pulse/store-audits/model";
import { loadStationAuditMaster } from "@/lib/ops-pulse/station-audits";
import { canDeleteStationAudit } from "@/lib/ops-pulse/station-audit-people";
import {
  auditDay,
  validAuditDate,
} from "@/lib/ops-pulse/station-audit-planning";
import { StoreAuditWorkspace } from "./workspace";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams?: { audit?: string; from?: string; to?: string };
}) {
  await requirePagePermission("store_audits", "access");
  const c = await context();
  const today = auditDay();
  const from =
    searchParams?.from && validAuditDate(searchParams.from)
      ? searchParams.from
      : today.slice(0, 7) + "-01";
  const to =
    searchParams?.to && validAuditDate(searchParams.to)
      ? searchParams.to
      : today.slice(0, 7) +
        "-" +
        new Date(
          Number(today.slice(0, 4)),
          Number(today.slice(5, 7)),
          0,
        ).getDate();
  const w = await workspace(c.auth, c.master, from, to);
  let focused = null;
  let error = "";
  if (searchParams?.audit)
    try {
      focused = (await readAudit(searchParams.audit, c)).audit;
    } catch {
      error = "This audit is unavailable in your store scope.";
    }
  const evidence = focused ? await proofs(c, focused.id) : [];
  const legacy = await loadStationAuditMaster(c.companyId);
  const manager = isManager(c.auth, c.master.settings);
  return (
    <AppShell active="Store Audits" pageCode="store_audits">
      <StoreAuditWorkspace
        key={focused?.id || "register"}
        {...w}
        focused={focused}
        evidence={evidence}
        error={error}
        from={from}
        to={to}
        userId={c.auth.userId}
        canSchedule={
          manager &&
          !c.auth.readOnly &&
          hasPermission(c.auth, "store_audits", "add")
        }
        canEdit={
          manager &&
          !c.auth.readOnly &&
          hasPermission(c.auth, "store_audits", "edit")
        }
        canInspect={Boolean(
          focused && canInspect(c.auth, c.master.settings, focused),
        )}
        canRespond={Boolean(
          focused && canRespond(c.auth, c.master.settings, focused),
        )}
        canDelete={canDeleteStationAudit(c.auth, legacy.programmeSettings)}
        canMaster={hasPermission(c.auth, "store_audit_master", "access")}
      />
    </AppShell>
  );
}
