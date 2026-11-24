import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PerformanceWorkspaceTabs } from "@/components/performance-workspace-tabs";
import { hasPermission } from "@/lib/authorization";
import { canViewDsLivePerformance } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsLivePerformanceAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsLivePerformance } from "@/lib/ops-pulse/ds-live-performance";
import { DsLiveView } from "./ds-live-view";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export default async function DarkStoreLivePerformancePage({
  searchParams
}: {
  searchParams?: { date?: string };
}) {
  const authorization = await requireDsLivePerformanceAccess();
  const canViewLive = canViewDsLivePerformance(authorization);
  const canViewReviews = hasPermission(authorization, "performance_review", "access");
  const canViewReviewStatus = hasPermission(authorization, "performance_review_status", "access");
  const date = String(searchParams?.date ?? "").trim();

  let error: string | null = null;
  let payload = null;
  try {
    payload = await loadDsLivePerformance(authorization, {
      businessDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Dark Store live performance.";
  }

  return (
    <AppShell active="Performance" pageCode="ds_live_performance">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Live performance"
          subtitle="PPI, Site Summary acceptance, and inbound from the WorkSpaces VM — board polls lightly; store detail loads on select."
          action={<span className="status-pill good">FSD · Admin · IST</span>}
        />
        <PerformanceWorkspaceTabs
          active="live"
          canViewLive={canViewLive}
          canViewReviews={canViewReviews}
          canViewReviewStatus={canViewReviewStatus}
          darkStore
        />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load live performance</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : payload ? (
          <DsLiveView initial={payload} />
        ) : null}
      </main>
    </AppShell>
  );
}
