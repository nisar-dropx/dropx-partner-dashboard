import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OpsLossReport } from "@/components/ops-loss-report";
import { requirePagePermission } from "@/lib/authorization";
import { loadLossReport, type LossReportKind } from "@/lib/ops-pulse/loss-reports";
export const dynamic = "force-dynamic";

/** Sub-pages of Team Ops → Losses. Order = tab order. */
const sections: Record<string, { report: LossReportKind; label: string; title: string; intro: string }> = {
  nl: {
    report: "nl",
    label: "NL Loss",
    title: "NL loss",
    intro: "Open NL loss cases from Cloak (eDSP), grouped by station. Pulled automatically every hour."
  },
  "slp-initial": {
    report: "slp_initial",
    label: "SLP Initial",
    title: "SLP loss · Initial recovery",
    intro: "Latest EDSP SLP Initial Recovery File, the first recovery list Amazon shares for the period."
  },
  "slp-final": {
    report: "slp_final",
    label: "SLP Final",
    title: "SLP loss · Final recovery",
    intro: "Latest EDSP SLP Final Recovery File, the settled recovery for the period."
  }
};

export default async function LossesSectionPage({ params, searchParams = {} }: { params: { section: string }; searchParams?: { station?: string } }) {
  const section = sections[params.section];
  if (!section) notFound();
  const auth = await requirePagePermission("ops_losses", "access");
  const basePath = `/attendance/losses/${params.section}`;
  const tabs = <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 20px 16px" }} aria-label="Loss reports">
    {Object.entries(sections).map(([key, s]) =>
      <a key={key} href={`/attendance/losses/${key}`} className={key === params.section ? "button" : "button secondary"} aria-current={key === params.section ? "page" : undefined}>{s.label}</a>)}
  </nav>;
  let content;
  try {
    const view = await loadLossReport(auth, section.report, searchParams.station);
    content = <OpsLossReport title={section.title} intro={section.intro} basePath={basePath} view={view} tabs={tabs} />;
  } catch (e) {
    content = <section className="panel" style={{ padding: 24 }}><h1>Losses</h1>{tabs}<p role="alert">{e instanceof Error ? e.message : "Loss report could not be loaded."}</p></section>;
  }
  return <AppShell active="Team Ops" pageCode="ops_losses">{content}</AppShell>;
}
