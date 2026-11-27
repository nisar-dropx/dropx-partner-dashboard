import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { datomsWorkerConfigured, loadDatomsThings } from "@/lib/ops-pulse/datoms-alerts";
import { DatomsShell } from "../datoms-shell";
import { DatomsListView } from "../list-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DatomsListPage() {
  const authorization = await requireDsOperationsAccess("ds_datoms");
  let error: string | null = null;
  let things: Awaited<ReturnType<typeof loadDatomsThings>> = [];
  try {
    things = await loadDatomsThings(authorization);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Datoms list.";
  }

  return (
    <DatomsShell authorization={authorization} active="list">
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load list</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : (
        <DatomsListView initialThings={things} workerConfigured={datomsWorkerConfigured()} />
      )}
    </DatomsShell>
  );
}
