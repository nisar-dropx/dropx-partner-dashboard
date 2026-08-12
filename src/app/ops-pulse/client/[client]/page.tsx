import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { inferFormTypeFromLocation, loadCodLocations, locationLabel } from "@/lib/ops-pulse/cod";
import { normalizeOpsClient } from "@/lib/ops-pulse/navigation";

export const dynamic = "force-dynamic";

const workflows = {
  amazon: [
    ["Daily Submission", "/ops-pulse/daily-submission?client=amazon", "Station EOD checklist and proof."],
    ["Executive Reconciliation", "/ops-pulse/cod/executive-reconciliation?client=amazon", "Associate cash counting with SCC validation."],
    ["COD Submission", "/ops-pulse/cod/submission?client=amazon", "Amazon remittance and deposit proof."],
    ["COD Reports", "/ops-pulse/cod/reports?client=amazon", "Amazon COD and closure reporting."],
    ["Cash In Associate", "/ops-pulse/cod/cash-in-associate?client=amazon", "Cash still held with delivery associates."]
  ],
  flipkart: [
    ["Daily Submission", "/ops-pulse/daily-submission?client=flipkart", "Flipkart station EOD checklist and proof."],
    ["COD Submission", "/ops-pulse/cod/submission?client=flipkart", "ERP COD, deposited amount, UTR/reference and deposit proof."],
    ["COD Reports", "/ops-pulse/cod/reports?client=flipkart", "Flipkart COD and closure reporting."]
  ]
} as const;

export default async function ClientOpsPage({ params }: { params: { client: string } }) {
  const client = normalizeOpsClient(params.client);
  if (!client) notFound();
  const authorization = await requirePagePermission("ops_pulse", "access");
  const companyId = requireCompanyId(authorization);
  const { locations } = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const clientLocations = locations.filter((location) => inferFormTypeFromLocation(location) === client);
  if (!clientLocations.length && !authorization.isMasterOwner && !authorization.isMasterCompany) redirect("/ops-pulse");
  const label = client === "amazon" ? "Amazon" : "Flipkart";

  return (
    <AppShell active={`${label} Operations`} pageCode="ops_pulse">
      <PageHead
        eyebrow="Ops Pulse"
        title={`${label} Operations`}
        subtitle={client === "amazon"
          ? "Amazon-specific closure flow with associate reconciliation, SCC Driver Reconciliation, open remittance, and Bank Deposit gates."
          : "Flipkart-specific closure flow using ERP COD, deposited amount, UTR/reference, proof validation, and manager exceptions."}
        action={<Link className="button secondary" href="/ops-pulse">Change client</Link>}
      />
      <section className="summary-grid">
        <div className="metric-card"><span>Client</span><strong>{label}</strong><small>Derived from provider master</small></div>
        <div className="metric-card"><span>Permitted stations</span><strong>{clientLocations.length}</strong><small>{clientLocations.map(locationLabel).slice(0, 3).join(", ") || "Owner configuration access"}</small></div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>{label} workflow</h2><p className="subtle">Only the steps relevant to this client are shown.</p></div></div>
        <div className="panel-body">
          <div className="summary-grid">
            {workflows[client].map(([title, href, description], index) => (
              <div className="metric-card" key={href}>
                <span>Step {index + 1}</span><strong>{title}</strong><small>{description}</small>
                <div className="form-actions" style={{ marginTop: 14 }}><Link className="button secondary" href={href}>Open</Link></div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
