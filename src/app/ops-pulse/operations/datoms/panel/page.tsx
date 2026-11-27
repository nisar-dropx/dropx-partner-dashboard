import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { datomsWorkerConfigured, loadDatomsThings } from "@/lib/ops-pulse/datoms-alerts";
import { DatomsShell } from "../datoms-shell";
import { DatomsPanelView } from "../panel-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DatomsPanelPage() {
  const authorization = await requireDsOperationsAccess("ds_datoms");
  let error: string | null = null;
  let things: Awaited<ReturnType<typeof loadDatomsThings>> = [];
  try {
    things = await loadDatomsThings(authorization);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Datoms panel.";
  }

  return (
    <DatomsShell authorization={authorization} active="panel">
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load panel</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : (
        <DatomsPanelView initialThings={things} workerConfigured={datomsWorkerConfigured()} />
      )}
    </DatomsShell>
  );
}
