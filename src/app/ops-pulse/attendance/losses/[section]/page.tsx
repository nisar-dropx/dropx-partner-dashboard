import { notFound } from "next/navigation";
import { OpsLossReport, type LossTab } from "@/components/ops-loss-report";
import { requirePagePermission } from "@/lib/authorization";
import {
  loadLossReport,
  type LossReportKind,
} from "@/lib/ops-pulse/loss-reports";
import { loadNlLoss, type NlFilters } from "@/lib/ops-pulse/nl-loss";
import { NlLossReport } from "@/components/nl-loss-report";
export const dynamic = "force-dynamic";

/** Sub-pages of Team Ops → Losses. Order = tab order. */
const sections: Record<
  string,
  { report: LossReportKind; label: string; title: string; intro: string }
> = {
  nl: {
    report: "nl",
    label: "NL Loss",
    title: "NL loss",
    intro:
      "Open NL loss cases from Cloak (eDSP), grouped by station. Refreshed every hour.",
  },
  "slp-initial": {
    report: "slp_initial",
    label: "SLP Initial",
    title: "SLP · Initial recovery",
    intro:
      "Amazon's first recovery list for the period (EDSP SLP Initial Recovery File).",
  },
  "slp-final": {
    report: "slp_final",
    label: "SLP Final",
    title: "SLP · Final recovery",
    intro:
      "The settled recovery for the period (EDSP SLP Final Recovery File).",
  },
};
const tabs: LossTab[] = Object.entries(sections).map(([key, s]) => ({
  key,
  label: s.label,
  href: `/attendance/losses/${key}`,
}));

export default async function LossesSectionPage({
  params,
  searchParams = {},
}: {
  params: { section: string };
  searchParams?: NlFilters & { period?: string };
}) {
  const section = sections[params.section];
  if (!section) notFound();
  const auth = await requirePagePermission("ops_losses", "access");
  let content;
  try {
    if (section.report === "nl")
      return (
        <NlLossReport view={await loadNlLoss(auth, searchParams)} tabs={tabs} />
      );
    const view = await loadLossReport(
      auth,
      section.report,
      searchParams.station,
      searchParams.period,
    );
    content = (
      <OpsLossReport
        title={section.title}
        intro={section.intro}
        basePath={`/attendance/losses/${params.section}`}
        view={view}
        tabs={tabs}
        activeTab={params.section}
      />
    );
  } catch (e) {
    content = (
      <section className="panel" style={{ padding: 24 }}>
        <h1>Losses</h1>
        <p role="alert">
          {e instanceof Error ? e.message : "Loss report could not be loaded."}
        </p>
      </section>
    );
  }
  return content;
}
