import { AppShell } from "@/components/app-shell";
import { CpsAdHocFilters } from "@/components/cps-adhoc-filters";
import { CpsAdHocTable } from "@/components/cps-adhoc-table";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { adHocClusterLabel, adHocDateRange, isAdHocActivityLocation, loadAdHocActivity } from "@/lib/ops-pulse/adhoc-activity";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import "./adhoc-activity.css";

export const dynamic = "force-dynamic";

type SearchParams = {
  from?: string;
  to?: string;
  month?: string;
  clusters?: string;
  stations?: string;
};

function listParam(value: string | undefined, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  return allowed.filter((item) => requested.has(item));
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" })
    .format(new Date(`${month}-01T12:00:00+05:30`));
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    .format(new Date(`${date}T12:00:00+05:30`));
}

function periodLabel(from: string, to: string, today: string) {
  if (from === to) return from === today ? `Today · ${dateLabel(from)}` : dateLabel(from);
  if (from === `${today.slice(0, 7)}-01` && to === today) return `${monthLabel(today.slice(0, 7))} MTD`;
  return `${dateLabel(from)} – ${dateLabel(to)}`;
}

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default async function CpsAdHocActivityPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cps_overview", "access");
  const companyId = requireCompanyId(authorization);
  const today = todayKolkata();
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const range = adHocDateRange({ from: searchParams?.from, to: searchParams?.to, month: searchParams?.month }, today);
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const allLocations = locationsResult.locations.filter(isAdHocActivityLocation);
  const clusterFor = (location: typeof allLocations[number]) => adHocClusterLabel(location);
  const clusters = [...new Set(allLocations.map(clusterFor))].sort((left, right) => left.localeCompare(right));
  const selectedClusters = listParam(searchParams?.clusters, clusters);
  const clusterSet = new Set(selectedClusters);
  const clusterLocations = allLocations.filter((location) => clusterSet.has(clusterFor(location)));
  const stationCodes = clusterLocations.map((location) => location.station_code);
  const selectedCodes = listParam(searchParams?.stations, stationCodes);
  const selectedCodeSet = new Set(selectedCodes);
  const selectedLocations = clusterLocations.filter((location) => selectedCodeSet.has(location.station_code));
  const activity = await loadAdHocActivity(companyId, selectedLocations, range.from, range.to);
  const periodName = periodLabel(range.from, range.to, today);
  const reportSearch = new URLSearchParams({ from: range.from, to: range.to });
  if (selectedClusters.length !== clusters.length) reportSearch.set("clusters", selectedClusters.join(",") || "_none");
  if (selectedCodes.length !== stationCodes.length) reportSearch.set("stations", selectedCodes.join(",") || "_none");
  const filterStations = allLocations.map((location) => ({
    code: location.station_code,
    name: location.station_name || location.city || location.station_code,
    cluster: clusterFor(location),
    region: location.region || "Unassigned"
  }));

  return (
    <AppShell active="Adhoc Van & DA" pageCode="cps_overview">
      <div className="ops-command-center cps-adhoc-workspace">
        <PageHead
          eyebrow={`CPS · ${range.state === "today" ? "Today" : range.state === "single" ? "Day view" : range.state === "mtd" ? "Month to date" : "Date range"}`}
          title="Adhoc Van & DA"
          subtitle="Station-wise jobs and cost from approved payment requests and Adhoc Van Cashbook payments."
          action={<span className="cps-adhoc-period-pill">{periodName}</span>}
        />
        <CpsAdHocFilters
          defaultFrom={defaultFrom}
          from={range.from}
          key={`${range.from}:${range.to}:${selectedClusters.join("|")}:${selectedCodes.join("|")}`}
          selectedClusters={selectedClusters}
          selectedStations={selectedCodes}
          stations={filterStations}
          to={range.to}
          today={today}
        />
        {locationsResult.error || activity.error ? <section className="panel message-panel error"><div className="panel-body"><strong>Adhoc activity is unavailable</strong><p className="subtle">{locationsResult.error ?? activity.error}</p></div></section> : null}

        <section className="cps-adhoc-kpis" aria-label="Adhoc activity summary">
          <article className="van"><span>Adhoc Van</span><strong>{activity.totals.vanCount}</strong><small>{money(activity.totals.vanAmount)}{activity.totals.cashbookVanCount ? ` · Cashbook paid ${money(activity.totals.cashbookVanAmount)}` : ""}</small></article>
          <article className="da"><span>Adhoc DA</span><strong>{activity.totals.daCount}</strong><small>{money(activity.totals.daAmount)} · includes Adhoc Driver</small></article>
          <article><span>Total jobs</span><strong>{activity.totals.totalCount}</strong><small>{activity.totals.activeStations} of {selectedLocations.length} stations</small></article>
          <article className="total"><span>Total amount</span><strong>{money(activity.totals.totalAmount)}</strong><small>{periodName}</small></article>
        </section>

        <section className="panel cps-adhoc-stations">
          <div className="panel-head"><div><h2>Station summary</h2><p className="subtle">Every selected station is shown. Click a station with activity to open its daily breakup.</p></div><span>{selectedLocations.length} stations</span></div>
          <CpsAdHocTable reportParams={reportSearch.toString()} stations={activity.stations} />
          <footer className="cps-adhoc-source-note">Head Office and Amazon Now locations are excluded. Includes approved, processing and processed requests plus Cashbook rows classified as Van Adhoc. Linked Cashbook payments are shown but never double-counted. Pending, returned and rejected requests are excluded.</footer>
        </section>
      </div>
    </AppShell>
  );
}
