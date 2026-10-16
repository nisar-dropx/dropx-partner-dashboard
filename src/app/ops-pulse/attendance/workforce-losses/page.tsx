import { AppShell } from "@/components/app-shell";
import { StationClaimsDesk } from "@/components/station-claims-desk";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { canRaiseClaims, loadStationClaims } from "@/lib/ops-pulse/station-claims";
import styles from "@/components/nl-loss.module.css";
export const dynamic = "force-dynamic";

/** Station loss claims now run through the Team Ops loss process; this page keeps the old entry point working. */
export default async function WorkforceLosses() {
  const auth = await requirePagePermission("ops_workforce_losses", "access");
  let content;
  try {
    const view = await loadStationClaims(auth);
    const canEdit = !auth.readOnly && hasPermission(auth, "ops_losses", "edit");
    content = view.ready ? (
      <StationClaimsDesk claims={view.claims} cases={view.cases} outcomes={view.outcomes} settings={view.settings}
        stations={view.stations.map((s) => ({ id: s.id, station_code: s.station_code }))}
        canRaise={canRaiseClaims(auth)} canEdit={canEdit} canRecovered={canEdit && hasPermission(auth, "ops_loss_recovered", "edit")} />
    ) : <p className={styles.notice}>Station claims become available once the latest database update is applied.</p>;
  } catch (e) {
    content = <p role="alert">{e instanceof Error ? e.message : "Station claims could not be loaded."}</p>;
  }
  return (
    <AppShell active="Team Ops" pageCode="ops_workforce_losses">
      <main className={styles.workspace}>
        <header className={styles.header}><div><span className={styles.eyebrow}>Team Ops</span><h1>Station loss claims</h1><p>Raise a loss your station found; the cluster manager approves it and the people responsible are recovered through payroll.</p></div></header>
        {content}
      </main>
    </AppShell>
  );
}
