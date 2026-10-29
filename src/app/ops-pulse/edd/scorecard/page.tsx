import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { EddSectionTabs } from "../edd-section-tabs";
import { ScorecardView, type ScorecardData } from "./scorecard-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RANGES = [7, 14, 30] as const;
const ist = (offsetDays: number) => {
  const d = new Date(Date.now() + 5.5 * 3600000);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};

export default async function ScorecardPage({ searchParams }: { searchParams?: { days?: string } }) {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const days = RANGES.find((d) => String(d) === searchParams?.days) ?? 7;
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const to = ist(1), from = ist(days);
  let data: ScorecardData | null = null;
  let error = "";
  if (stations.length && supabaseAdmin) {
    // Shipment data changes once a day, so one aggregate per company, station set and range is cached for 10 minutes.
    const codes = stations.map((s) => s.code).sort();
    // Only successful results are cached; an error throws so the next visit retries.
    try {
      data = await unstable_cache(
        async () => {
          const r = await supabaseAdmin!.rpc("ops_delivery_scorecard", { p_company: companyId, p_stations: codes, p_from: from, p_to: to });
          if (r.error) throw new Error(r.error.message);
          return r.data as ScorecardData;
        },
        ["delivery-scorecard", companyId, from, to, codes.join(",")],
        { revalidate: 600 }
      )();
    } catch (e) {
      error = /ops_delivery_scorecard/.test(e instanceof Error ? e.message : "") ? "The scorecard becomes available once the latest database update is applied." : "The scorecard could not be loaded. Please retry.";
    }
  }
  return (
    <AppShell active="Live performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead eyebrow="Ops Pulse · Scorecard" title="Delivery scorecard" subtitle="Station scorecard against the previous period, with each station's DA leaderboard. From the daily shipment file, up to yesterday." />
        <EddSectionTabs active="scorecard" />
        {error ? <section className="panel message-panel error"><div className="panel-body"><strong>{error}</strong></div></section> : null}
        {!stations.length ? <section className="panel message-panel error"><div className="panel-body"><strong>No stations in your scope.</strong></div></section> : null}
        {data ? <ScorecardView data={data} days={days} ranges={[...RANGES]} from={from} to={to} stationNames={Object.fromEntries(stations.map((s) => [s.code, s.name]))} /> : null}
      </div>
    </AppShell>
  );
}
