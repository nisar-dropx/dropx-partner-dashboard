import { notFound } from "next/navigation";
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
const tabs: LossTab[] = [
  ...Object.entries(sections).map(([key, s]) => ({
    key,
    label: s.label,
    href: `/team-ops/losses/${key}`,
  })),
  { key: "claims", label: "Station Claims", href: "/team-ops/losses/claims" },
  { key: "ledger", label: "Recovery Ledger", href: "/team-ops/losses/ledger" },
];

export default async function LossesSectionPage({
  params,
  searchParams = {},
}: {
  params: { section: string };
  searchParams?: NlFilters;
}) {
  if (params.section === "claims") {
    const auth = await requirePagePermission("ops_losses", "access");
    try {
      const view = await loadStationClaims(auth);
      const canEdit = !auth.readOnly && hasPermission(auth, "ops_losses", "edit");
      return (
        <main className={styles.workspace}>
          <LossHeader eyebrow="Team Ops · Losses" title="Station loss claims" intro="Losses a station finds itself, approved by the cluster manager and recovered through the same payroll trail." tabs={tabs} active="claims" />
          {view.ready ? (
            <StationClaimsDesk claims={view.claims} cases={view.cases} outcomes={view.outcomes} settings={view.settings}
              stations={view.stations.map((s) => ({ id: s.id, station_code: s.station_code }))}
              canRaise={canRaiseClaims(auth)} canEdit={canEdit} canRecovered={canEdit && hasPermission(auth, "ops_loss_recovered", "edit")} />
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
    const auth = await requirePagePermission("ops_losses", "access");
    try {
      const ledger = await loadRecoveryLedger(auth);
      return (
        <main className={styles.workspace}>
          <LossHeader
            eyebrow="Team Ops · Losses"
            title="Recovery ledger"
            intro="Every loss assigned to a person, traced to the salary deductions that recover it."
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
  const section = sections[params.section];
  if (!section) notFound();
  const auth = await requirePagePermission("ops_losses", "access");
  try {
    if (section.report === "nl") {
      if (searchParams.view === "historic")
        return (
          <NlLossReport
            view={await loadRecoveryView(auth, "nl", searchParams)}
            tabs={tabs}
          />
        );
      const live = await loadNlLive(auth, searchParams);
      // With no explicit choice, open on whichever data set needs work: the live month
      // while a station window is open (or its dates are unknown), else closed months.
      const stage = windowSummary(live.window).stage;
      const liveFirst =
        live.ready &&
        !!live.month &&
        (stage === null || stage === "eDSP1" || stage === "eDSP2");
      if (searchParams.view === "live" || liveFirst)
        return <NlLiveReport view={live} tabs={tabs} />;
      return (
        <NlLossReport
          view={await loadRecoveryView(auth, "nl", searchParams)}
          tabs={tabs}
        />
      );
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
