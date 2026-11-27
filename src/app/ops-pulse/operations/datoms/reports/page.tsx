import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { datomsWorkerConfigured, loadDatomsReports } from "@/lib/ops-pulse/datoms-alerts";
import { DatomsShell } from "../datoms-shell";
import { DatomsReportsView } from "../reports-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DatomsReportsPage() {
  const authorization = await requireDsOperationsAccess("ds_datoms");
  let error: string | null = null;
  let reports: Awaited<ReturnType<typeof loadDatomsReports>> = [];
  try {
    reports = await loadDatomsReports(authorization);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Datoms reports.";
  }

  return (
    <DatomsShell authorization={authorization} active="reports">
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load reports</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : (
        <DatomsReportsView initialReports={reports} workerConfigured={datomsWorkerConfigured()} />
      )}
    </DatomsShell>
  );
}
