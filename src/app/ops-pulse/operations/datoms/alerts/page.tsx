import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { datomsWorkerConfigured, loadDatomsAlerts } from "@/lib/ops-pulse/datoms-alerts";
import { DatomsShell } from "../datoms-shell";
import { DatomsAlertsView } from "../alerts-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DatomsAlertsPage() {
  const authorization = await requireDsOperationsAccess("ds_datoms");
  let error: string | null = null;
  let alerts: Awaited<ReturnType<typeof loadDatomsAlerts>> = [];
  try {
    alerts = await loadDatomsAlerts(authorization);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Datoms alerts.";
  }

  return (
    <DatomsShell
      authorization={authorization}
      active="alerts"
      subtitle="L1–L3 cold-chain violations for your stores. L2/L3 still fan out to WhatsApp war rooms."
    >
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load alerts</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : (
        <DatomsAlertsView initialAlerts={alerts} workerConfigured={datomsWorkerConfigured()} />
      )}
    </DatomsShell>
  );
}
