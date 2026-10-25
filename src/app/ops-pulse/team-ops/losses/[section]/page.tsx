import { mayViewLossApprovals } from "@/lib/ops-pulse/loss-recovery-controls";
import { loadRecoveryWorkspace } from "@/lib/ops-pulse/loss-recovery-workspace";
import { LossRecoveryWorkspace } from "@/components/loss-recovery-workspace";
import { LossRedisputeDesk } from "@/components/loss-redispute-desk";
import { readAllRows } from "@/lib/supabase-pagination";
import { defaultLossFilter } from "@/lib/ops-pulse/loss-recovery-controls";
import { notFound, redirect } from "next/navigation";
import { OpsLossReport, type LossTab } from "@/components/ops-loss-report";
import { requirePagePermission } from "@/lib/authorization";
import { loadLossReport, type LossReportKind } from "@/lib/ops-pulse/loss-reports";
import {
  loadRecoveryView,
  lossSchemaReady,
  type NlFilters,
  type RecoveryKind,
} from "@/lib/ops-pulse/nl-loss";
import { loadNlLive } from "@/lib/ops-pulse/nl-live";
import { windowSummary } from "@/lib/ops-pulse/nl-dispute-policy";
import { NlLossReport } from "@/components/nl-loss-report";
import { NlLiveReport } from "@/components/nl-live-report";
import { LossHeader } from "@/components/nl-loss-report";
import { NlRecoveryLedger } from "@/components/nl-recovery-ledger";
import { loadRecoveryLedger } from "@/lib/ops-pulse/nl-recovery-ledger";
import { StationClaimsDesk } from "@/components/station-claims-desk";
import { canRaiseClaims, loadStationClaims } from "@/lib/ops-pulse/station-claims";
import { hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import styles from "@/components/nl-loss.module.css";
export const dynamic = "force-dynamic";

/** Sub-pages of Team Ops → Losses. Order = tab order. */
const sections: Record<
  string,
  { report: RecoveryKind | Extract<LossReportKind, "potential_loss">; label: string; title: string; intro: string }
> = {
  nl: {
    report: "nl",
    label: "NL Loss",
    title: "NL loss",
    intro: "NL loss cases from Cloak (eDSP). Refreshed every hour.",
  },
  "slp-initial": {
    report: "slp_initial",
    label: "SLP Initial",
    title: "SLP · Initial recovery",
    intro:
      "Amazon's first recovery list for the period (EDSP SLP Initial Recovery File). Report only — employees are assigned for recovery on SLP Final.",
  },
  "slp-final": {
    report: "slp_final",
    label: "SLP Final",
    title: "SLP · Final recovery",
    intro:
      "The settled recovery for the period (EDSP SLP Final Recovery File).",
  },
  potential: {
    report: "potential_loss",
    label: "Potential Loss",
    title: "Potential package loss",
    intro:
      "Amazon's daily list of packages at risk of becoming a loss (EDSP Daily_Potential Package Loss_Consolidated Report). Report only — nothing here is assigned for recovery.",
  },
};
const primaryTabs: LossTab[] = [
 {key:"nl",label:"Disputes & outcomes",href:"/team-ops/losses/nl"},
 {key:"recovery",label:"Recovery",href:"/team-ops/losses/recovery"},
 {key:"approvals",label:"Approvals",href:"/team-ops/losses/approvals"},
 {key:"redisputes",label:"Redisputes",href:"/team-ops/losses/redisputes"},
 {key:"claims",label:"Station claims",href:"/team-ops/losses/claims"},
 {key:"ledger",label:"Collections",href:"/team-ops/losses/ledger"},
];

export default async function LossesSectionPage({
  params,
  searchParams = {},
}: {
  params: { section: string };
  searchParams?: NlFilters;
}) {
  const auth = await requirePagePermission("ops_losses", "access");
  const restricted = mayViewLossApprovals(auth);
  const tabs = primaryTabs.filter(t => !["approvals","redisputes"].includes(t.key) || restricted);
  if (["recovery","approvals","redisputes"].includes(params.section)) {
    if (params.section !== "recovery" && !restricted) notFound();
    const [view, claimView] = await Promise.all([loadRecoveryWorkspace(auth, params.section === "redisputes"), params.section === "approvals" ? loadStationClaims(auth) : Promise.resolve(null)]);
    if (params.section === "redisputes") {
      const result = await readAllRows(supabaseAdmin!.from("nl_case_response_windows").select("*").eq("company_id",auth.companyId).order("updated_at",{ascending:false}).order("month").order("case_key"));
      if(result.error) throw Error("Redisputes could not be loaded.");
      const scope = new Set(view.rows.map(r=>`${r.month}|${r.case_key}`));
      return <main className={styles.workspace}><LossHeader title="Redisputes" intro="Restricted case activation, LSC tickets and vendor follow-up." tabs={tabs} active="redisputes"/><LossRedisputeDesk rows={view.rows} windows={(result.data||[]).filter(w=>scope.has(`${w.month}|${w.case_key}`))}/></main>;
    }
    return <main className={styles.workspace}><LossHeader title={params.section==="approvals"?"Final approvals":"Recovery"} intro="Station updates become final only after independent approval. Unpaid balances carry forward." tabs={tabs} active={params.section}/>{claimView?.claims.some(c=>c.actions.includes("approve"))?<p className={styles.notice}><a href="/team-ops/losses/claims">{claimView.claims.filter(c=>c.actions.includes("approve")).length} station claims also await your final approval →</a></p>:null}<LossRecoveryWorkspace {...view} approvals={params.section==="approvals"}/></main>;
  }
  if (params.section === "claims") {
    try {
      const view = await loadStationClaims(auth);
      const canEdit = !auth.readOnly && hasPermission(auth, "ops_losses", "edit");
      return (
        <main className={styles.workspace}>
          <LossHeader eyebrow="Team Ops · Losses" title="Station loss claims" intro="Raise a loss, obtain final approval, then recover through the shared recovery queue." tabs={tabs} active="claims" />
          {view.ready ? (
            <StationClaimsDesk claims={view.claims} cases={view.cases} outcomes={view.outcomes} settings={view.settings}
              stations={view.stations.map((s) => ({ id: s.id, station_code: s.station_code }))}
              canRaise={canRaiseClaims(auth)} canEdit={canEdit} canRecovered={canEdit} />
          ) : (
            <p className={styles.notice}>Station claims become available once the station loss claims update is applied to the database.</p>
          )}
        </main>
      );
    } catch (e) {
      return <section className="panel" style={{ padding: 24 }}><h1>Station loss claims</h1><p role="alert">{e instanceof Error ? e.message : "Station claims could not be loaded."}</p></section>;
    }
  }
  if (params.section === "ledger") {
    try {
      const ledger = await loadRecoveryLedger(auth);
      return (
        <main className={styles.workspace}>
          <LossHeader
            eyebrow="Team Ops · Losses"
            title="Collections"
            intro="Verified payroll deductions, outstanding balances and write-offs. Plans remain open until collected."
            tabs={tabs}
            active="ledger"
          />
          {ledger.ready ? (
            <NlRecoveryLedger lines={ledger.lines} canWriteOff={ledger.canWriteOff} />
          ) : (
            <p className={styles.notice}>
              The recovery ledger becomes available once the loss recovery instalments update is applied to the database.
            </p>
          )}
        </main>
      );
    } catch (e) {
      return (
        <section className="panel" style={{ padding: 24 }}>
          <h1>Recovery ledger</h1>
          <p role="alert">{e instanceof Error ? e.message : "The recovery ledger could not be loaded."}</p>
        </section>
      );
    }
  }
  // Digest / lifecycle helpers once emitted /team-ops/losses/slp — map to real tabs.
  if (params.section === "slp") {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value == null || value === "") continue;
      q.set(key, Array.isArray(value) ? String(value[0]) : String(value));
    }
    const caseKey = q.get("case") || "";
    const month = q.get("month") || "";
    let target: "slp-initial" | "slp-final" = "slp-final";
    if (auth.companyId && caseKey && month && supabaseAdmin) {
      const row = await supabaseAdmin
        .from("nl_loss_month_cases")
        .select("final_seen_at")
        .eq("company_id", auth.companyId)
        .eq("month", month)
        .eq("case_key", caseKey)
        .eq("report", "slp")
        .maybeSingle();
      if (row.data && row.data.final_seen_at == null) target = "slp-initial";
    }
    const qs = q.toString();
    redirect(qs ? `/team-ops/losses/${target}?${qs}` : `/team-ops/losses/${target}`);
  }
  const section = sections[params.section];
  if (!section) notFound();
  try {
    if (section.report === "nl") {
      const stageView = searchParams.view === "historic" || searchParams.view === "final"
        ? "final" : searchParams.view === "live" || searchParams.view === "initial"
          ? "initial" : defaultLossFilter() === "recoverable" ? "final" : "initial";
      return <NlLiveReport view={await loadNlLive(auth, searchParams, stageView)} tabs={tabs} />;
    }
    // Potential loss and SLP Initial are read-only reports; SLP is assigned for recovery on SLP Final only.
    if (section.report === "slp_final" && (await lossSchemaReady()))
      return (
        <NlLossReport
          view={await loadRecoveryView(auth, section.report, searchParams)}
          tabs={tabs}
        />
      );
    // Read-only listing: potential loss and SLP Initial always; SLP Final until the recovery ledger migration is applied.
    return (
      <OpsLossReport
        title={section.title}
        intro={section.intro}
        basePath={`/team-ops/losses/${params.section}`}
        view={await loadLossReport(
          auth,
          section.report,
          searchParams.station,
          searchParams.period,
        )}
        tabs={tabs}
        activeTab={params.section}
      />
    );
  } catch (e) {
    return (
      <section className="panel" style={{ padding: 24 }}>
        <h1>Losses</h1>
        <p role="alert">
          {e instanceof Error ? e.message : "Loss report could not be loaded."}
        </p>
      </section>
    );
  }
}
