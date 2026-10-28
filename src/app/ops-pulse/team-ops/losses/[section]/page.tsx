import { LossSummary } from "@/components/loss-station-table";
import { lossFacts } from "@/lib/ops-pulse/loss-station-summary";
import { LossDebitReview } from "@/components/loss-debit-review";
import { LossRecoveryUpdates } from "@/components/loss-recovery-updates";
import { recoveryUpdates } from "@/lib/ops-pulse/loss-recovery-updates";
import { indiaMonth } from "@/lib/ops-pulse/loss-recovery-queue-policy";
import { loadLossDebits } from "@/lib/ops-pulse/loss-debit-data";
import { mayViewLossApprovals, mayMarkAlreadyRecovered, defaultLossFilter } from "@/lib/ops-pulse/loss-recovery-controls";
import { loadRecoveryWorkspace } from "@/lib/ops-pulse/loss-recovery-workspace";
import { LossRecoveryWorkspace } from "@/components/loss-recovery-workspace";
import { LossExceptionsDesk } from "@/components/loss-exceptions-desk";
import { LossRedisputeDesk } from "@/components/loss-redispute-desk";
import { readAllRows } from "@/lib/supabase-pagination";
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
 {key:"exceptions",label:"Exceptions",href:"/team-ops/losses/exceptions"},
 {key:"claims",label:"Station claims",href:"/team-ops/losses/claims"},
 {key:"ledger",label:"Balances",href:"/team-ops/losses/ledger"},
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
  const tabs = primaryTabs.filter(t => t.key !== "exceptions" || restricted);
  if (params.section === "recovery") {
    const payroll = searchParams.view === "payroll";
    const view = payroll ? null : await loadRecoveryWorkspace(auth);
    return <main className={styles.workspace}>
      <LossHeader title="Recovery" intro="Saved recovery updates till date, pending collections and confirmed recoveries. Ongoing initial cases remain in Disputes & outcomes." tabs={tabs} active="recovery"/>
      <nav className={styles.toolbar} style={{ justifyContent: "flex-start" }} aria-label="Recovery views">
        <a className={!payroll ? styles.primary : styles.button} aria-current={!payroll ? "page" : undefined} href="/team-ops/losses/recovery">Saved recovery updates</a>
        <a className={payroll ? styles.primary : styles.button} aria-current={payroll ? "page" : undefined} href="/team-ops/losses/recovery?view=payroll">Payroll deductions</a>
      </nav>
      {payroll ? <LossDebitReview rows={await loadLossDebits(auth)}/> : view ? <LossRecoveryUpdates rows={recoveryUpdates(view.rows, view.lines, view.settings?.recoverable_statuses || [], indiaMonth())}/> : null}
    </main>;
  }
  if (["approvals","redisputes"].includes(params.section)) {
    if (!restricted) notFound();
    redirect('/team-ops/losses/exceptions?view=' + (params.section==='redisputes'?'redisputes':'review'));
  }
  if (params.section === 'exceptions') {
    if (!restricted) notFound();
    const selected = searchParams.view === 'redisputes' ? 'redisputes' : searchParams.view === 'review' ? 'review' : 'enable';
    const view = await loadRecoveryWorkspace(auth, selected !== 'review');
    const [windows, grants] = await Promise.all([
      readAllRows(supabaseAdmin!.from('nl_case_response_windows').select('*').eq('company_id',auth.companyId).order('updated_at',{ascending:false}).order('month').order('case_key')),
      readAllRows(supabaseAdmin!.from('nl_loss_exception_options').select('*').eq('company_id',auth.companyId).order('month').order('case_key').order('kind')),
    ]);
    if (windows.error || grants.error) throw Error('Exceptions could not be loaded. Retry after the exception update is available.');
    const scope=new Set(view.rows.map(r=>r.month+'|'+r.case_key));
    const scopedWindows=(windows.data||[]).filter(w=>scope.has(w.month+'|'+w.case_key));
    return <main className={styles.workspace}>
      <LossHeader title="Exceptions" intro="SLP Manager, Finance Manager, Managing Partner and National Head can enable TID options and review station submissions within their permitted stations." tabs={tabs} active="exceptions"/>
      <nav className={styles.toolbar} aria-label="Exception views" style={{justifyContent:'flex-start'}}>{[['enable','Enable exceptions'],['redisputes','Redispute submissions'],['review','Review required']].map(([key,label])=><a key={key} className={selected===key?styles.primary:styles.button} href={'/team-ops/losses/exceptions?view='+key} aria-current={selected===key?'page':undefined}>{label}</a>)}</nav>
      {selected==='redisputes'?<LossRedisputeDesk rows={view.rows} windows={scopedWindows} canActivate={view.canApprove}/> : selected==='review'?<LossRecoveryWorkspace {...view} approvals/> : <LossExceptionsDesk rows={view.rows} grants={(grants.data||[]).filter(g=>scope.has(g.month+'|'+g.case_key))} windows={scopedWindows} canEdit={view.canApprove} recoverableStatuses={view.settings?.recoverable_statuses||[]}/>}
    </main>;
  }
  if (params.section === 'recovery-updates') {
    const view=await loadRecoveryWorkspace(auth);
    return <main className={styles.workspace}><LossHeader title="Recovery" intro="Save recovery against the current payroll, or choose an exception enabled for this TID." tabs={tabs} active="recovery"/><LossRecoveryWorkspace {...view}/></main>;
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
              canRaise={canRaiseClaims(auth)} canEdit={canEdit} canRecovered={canEdit && mayMarkAlreadyRecovered(auth)} />
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
            title="Recovery review"
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
    let target: "slp-initial" | "slp-final" = searchParams.view === "initial" ? "slp-initial" : "slp-final";
    if (!searchParams.view && auth.companyId && caseKey && month && supabaseAdmin) {
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
  if (params.section === "summary") {
    const [workspace, ledger] = await Promise.all([loadRecoveryWorkspace(auth, true), loadRecoveryLedger(auth)]);
    return <main className={styles.workspace}><LossHeader title="Loss summary" intro="Station-wise confirmed recoverable NL and SLP cases, updates and recovery." tabs={tabs} active="summary"/>
      <LossSummary facts={lossFacts(workspace.rows, ledger.lines, workspace.settings?.recoverable_statuses || [])} ledgerReady={ledger.ready}/></main>;
  }
  const section = sections[params.section];
  if (!section) notFound();
  try {
    if (section.report === "nl") {
      const stageView = searchParams.view === "historic" || searchParams.view === "final"
        ? "final" : searchParams.view === "live" || searchParams.view === "initial"
          ? "initial" : defaultLossFilter() === "recoverable" ? "final" : "initial";
      const [view, ledger] = await Promise.all([loadNlLive(auth, searchParams, stageView), loadRecoveryLedger(auth)]);
      return <NlLiveReport view={view} facts={lossFacts(view.overviewRows, ledger.lines, view.settings?.recoverable_statuses || [])} ledgerReady={ledger.ready} tabs={tabs} />;
    }
    if ((section.report === "slp_final" || section.report === "slp_initial") && (await lossSchemaReady())) {
      const [view, ledger] = await Promise.all([loadRecoveryView(auth, section.report, searchParams), loadRecoveryLedger(auth)]);
      return <NlLossReport view={view} facts={lossFacts(view.overviewRows, ledger.lines, view.settings?.recoverable_statuses || [])} ledgerReady={ledger.ready} tabs={tabs}/>;
    }
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
