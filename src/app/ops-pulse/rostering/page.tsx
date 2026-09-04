import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { OpsRosterApprovals } from "@/components/ops-roster-approvals";
import { OpsRosterPlanner } from "@/components/ops-roster-planner";
import rosterStyles from "@/components/ops-roster-planner.module.css";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import {
  loadAssignedOpsRosterApprovals,
  loadOpsRosterCapabilities,
  loadOpsRosteringPolicy,
  loadOpsRosterWorkspace,
  resolveOpsRosterApprovalRoute
} from "@/lib/ops-pulse/rostering";

export const dynamic = "force-dynamic";

type Search = { station?: string; view?: string };

export default async function OpsRosteringPage({ searchParams }: { searchParams?: Search }) {
  const authorization = await requirePagePermission("ops_rostering", "access");
  const companyId = requireCompanyId(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationResult.locations.filter((location) => !location.hide_from_location_list);
  const selected = locations.find((location) => location.station_code === String(searchParams?.station ?? "").toUpperCase()) ?? locations[0] ?? null;
  const view = searchParams?.view === "approvals" ? "approvals" : "roster";
  const [capabilities, approvals, workspace, policy] = await Promise.all([
    loadOpsRosterCapabilities(authorization),
    loadAssignedOpsRosterApprovals(authorization),
    selected ? loadOpsRosterWorkspace(companyId, selected) : Promise.resolve(null),
    loadOpsRosteringPolicy(companyId, selected?.id)
  ]);
  const route = capabilities.canPlan ? await resolveOpsRosterApprovalRoute(authorization, policy, selected?.id) : null;
  const selectedPlan = workspace?.selectedPlan ?? null;
  const canAdd = hasPermission(authorization, "ops_rostering", "add") && capabilities.canPlan;
  const canEdit = hasPermission(authorization, "ops_rostering", "edit") && capabilities.canPlan;
  const editable = Boolean(canEdit && selectedPlan && ["draft", "returned"].includes(selectedPlan.status));
  // Open drafts are edited in place; canStart prepares a new draft only when none is open.
  const canStart = Boolean(canAdd && workspace && (!workspace.openPlan || editable));
  const accessLabel = !capabilities.canPlan
    ? (capabilities.canApprove ? "Approver access" : "View only")
    : selectedPlan?.status === "pending_approval"
      ? "Change pending approval"
      : editable || canStart
        ? "Can prepare roster changes"
        : "View only";
  const approvalSummary = route?.summary
    ?? (capabilities.canApprove ? "Open My approvals to act on assigned roster requests." : "Your access is view-only.");

  return <AppShell active="Rostering" pageCode="ops_rostering">
    <div className="ops-command-center">
      <PageHead
        eyebrow="Workforce planning"
        title="Rostering"
        subtitle="View, change and approve the same station roster used by People, attendance and payroll."
      />
      {locationResult.error ? <div className="message-panel error">{locationResult.error}</div> : null}
      <section className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-body" style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
          <form method="get" style={{ display: "flex", alignItems: "end", gap: 8, flex: "1 1 420px" }}>
            <input type="hidden" name="view" value="roster" />
            <label style={{ display: "grid", gap: 5, flex: 1, minWidth: 220 }}><span className="field-label">Station</span><select name="station" defaultValue={selected?.station_code}>{locations.map((location) => <option key={location.id} value={location.station_code}>{location.station_code} · {location.station_name || location.city || "Station"}</option>)}</select></label>
            <button type="submit" className="button secondary compact">Load station</button>
          </form>
          <div className={rosterStyles.tabs} aria-label="Rostering view">
            <Link className={view === "roster" ? rosterStyles.activeTab : ""} href={`/rostering?station=${encodeURIComponent(selected?.station_code ?? "")}`}>Station roster</Link>
            <Link className={view === "approvals" ? rosterStyles.activeTab : ""} href={`/rostering?view=approvals&station=${encodeURIComponent(selected?.station_code ?? "")}`}>My approvals <span className="status-pill neutral">{approvals.length}</span></Link>
          </div>
        </div>
      </section>

      {view === "approvals" ? <OpsRosterApprovals approvals={approvals} /> : selected && workspace ? <>
        <div className="capacity-action-line" style={{ marginBottom: 10 }}>
          <strong>{capabilities.designationName || authorization.roleName || "Authorised user"}</strong>
          <span>{accessLabel} · approval from People masters · location manager → reporting manager → HR</span>
        </div>
        <OpsRosterPlanner
          key={`${selected.id}:${selectedPlan?.id ?? "blank"}`}
          stationId={selected.id}
          stationCode={selected.station_code}
          plan={selectedPlan}
          blankPeriodStart={workspace.blankPeriodStart}
          initialWeekStart={workspace.currentWeekStart}
          people={workspace.people}
          shifts={workspace.shifts}
          holidays={workspace.holidays}
          defaultShifts={workspace.defaultShifts}
          canStart={canStart}
          editable={editable}
          approvalSummary={approvalSummary}
          approvalRequired={Boolean(route?.approvalRequired)}
          routeReady={!route?.error}
          today={workspace.today}
          nowIso={new Date().toISOString()}
          changeCutoffHours={policy.changeCutoffHours}
        />
      </> : <section className="panel"><div className="empty-cell">No station is available in your OpsPulse location scope.</div></section>}
    </div>
  </AppShell>;
}
