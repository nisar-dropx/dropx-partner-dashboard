import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import {
  canViewDsOperations,
  hasDsOperationsRole
} from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { requireCompanyId } from "@/lib/company-scope";
import { loadDsMessagePolicies } from "@/lib/ops-pulse/ds-message-policy-store";
import { DsMessagePoliciesView } from "./ds-message-policies-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DarkStoreMessagePoliciesPage() {
  const authorization = await requireDsOperationsAccess("ds_message_policies");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const canViewColdChain = canViewDsOperations(authorization, "ds_cold_chain_alerts");
  const canViewPulse = canViewDsOperations(authorization, "ds_workforce_pulse");
  const canViewPolicies = canViewDsOperations(authorization, "ds_message_policies");
  const canEdit =
    hasDsOperationsRole(authorization) ||
    Boolean(
      authorization.permissions?.ds_message_policies?.canEdit ||
        authorization.permissions?.ds_message_policies?.canAdd
    );

  let error: string | null = null;
  let policies: Awaited<ReturnType<typeof loadDsMessagePolicies>> = [];
  try {
    const companyId = requireCompanyId(authorization);
    policies = await loadDsMessagePolicies(companyId);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load message policies.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_message_policies">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Message policies"
          subtitle="Urgency, frequency and cooldown for WhatsApp alerts — cron jobs and monitors read these values instead of hardcoded env defaults."
          action={<span className="status-pill good">DB-backed</span>}
        />
        <DsOperationsTabs
          active="policies"
          canViewLive={canViewLive}
          canViewPpi={canViewPpi}
          canViewSite={canViewSite}
          canViewColdChain={canViewColdChain}
          canViewPulse={canViewPulse}
          canViewPolicies={canViewPolicies}
        />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load policies</strong>
              <p className="subtle" style={{ marginTop: 6 }}>
                {error}
              </p>
            </div>
          </section>
        ) : (
          <DsMessagePoliciesView initialPolicies={policies} canEdit={canEdit} />
        )}
      </main>
    </AppShell>
  );
}