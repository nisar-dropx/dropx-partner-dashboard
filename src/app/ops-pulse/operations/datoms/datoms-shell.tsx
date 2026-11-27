import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { DsDatomsTabs, type DatomsHubTab } from "@/components/ds-datoms-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import type { AuthorizationContext } from "@/lib/authorization";

export function DatomsShell({
  authorization,
  active,
  children,
  subtitle = "Store-scoped cold-chain telemetry from Datoms — alerts first, then panel, list, and reports. Data is cached; login stays on the keep-alive cron."
}: {
  authorization: AuthorizationContext;
  active: DatomsHubTab;
  children: ReactNode;
  subtitle?: string;
}) {
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const canViewDatoms = canViewDsOperations(authorization, "ds_datoms");
  const canViewPulse = canViewDsOperations(authorization, "ds_workforce_pulse");
  const canViewPolicies = canViewDsOperations(authorization, "ds_message_policies");

  return (
    <AppShell active="Operations" pageCode="ds_datoms">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="DATOMS"
          subtitle={subtitle}
          action={<span className="status-pill good">Session · cached</span>}
        />
        <DsOperationsTabs
          active="datoms"
          canViewLive={canViewLive}
          canViewPpi={canViewPpi}
          canViewSite={canViewSite}
          canViewDatoms={canViewDatoms}
          canViewPulse={canViewPulse}
          canViewPolicies={canViewPolicies}
        />
        <DsDatomsTabs active={active} />
        {children}
      </main>
    </AppShell>
  );
}
