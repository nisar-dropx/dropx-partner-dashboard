import { AppShell } from "@/components/app-shell";
import { CpsAdHocFilters } from "@/components/cps-adhoc-filters";
import { CpsAdHocTable } from "@/components/cps-adhoc-table";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { adHocMonthRange, loadAdHocActivity, validAdHocMonth } from "@/lib/ops-pulse/adhoc-activity";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import "./adhoc-activity.css";

export const dynamic = "force-dynamic";

type SearchParams = {
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

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default async function CpsAdHocActivityPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cps_overview", "access");
  const companyId = requireCompanyId(authorization);
  const today = todayKolkata();
  const currentMonth = today.slice(0, 7);
  const month = validAdHocMonth(searchParams?.month, today);
  const range = adHocMonthRange(month, today);
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const allLocations = locationsResult.locations;
  const clusterFor = (location: typeof allLocations[number]) => String(location.cluster || location.cluster_manager || "Unassigned").trim() || "Unassigned";
  const clusters = [...new Set(allLocations.map(clusterFor))].sort((left, right) => left.localeCompare(right));
  const selectedClusters = listParam(searchParams?.clusters, clusters);
  const clusterSet = new Set(selectedClusters);
  const clusterLocations = allLocations.filter((location) => clusterSet.has(clusterFor(location)));
  const stationCodes = clusterLocations.map((location) => location.station_code);
  const selectedCodes = listParam(searchParams?.stations, stationCodes);
  const selectedCodeSet = new Set(selectedCodes);
  const selectedLocations = clusterLocations.filter((location) => selectedCodeSet.has(location.station_code));
  const activity = await loadAdHocActivity(companyId, selectedLocations, range.from, range.to);
  const periodName = range.state === "mtd" ? `${monthLabel(month)} MTD` : monthLabel(month);
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
          eyebrow={`CPS · ${range.state === "mtd" ? "Month to date" : "Monthly"}`}
          title="Adhoc Van & DA"
          subtitle="Station-wise jobs and cost, with day-level detail from approved payment requests."
          action={<span className="cps-adhoc-period-pill">{periodName}</span>}
        />
        <CpsAdHocFilters
          currentMonth={currentMonth}
          key={`${month}:${selectedClusters.join("|")}:${selectedCodes.join("|")}`}
          month={month}
          selectedClusters={selectedClusters}
          selectedStations={selectedCodes}
          stations={filterStations}
        />
        {locationsResult.error || activity.error ? <section className="panel message-panel error"><div className="panel-body"><strong>Adhoc activity is unavailable</strong><p className="subtle">{locationsResult.error ?? activity.error}</p></div></section> : null}

        <section className="cps-adhoc-kpis" aria-label="Adhoc activity summary">
          <article className="van"><span>Adhoc Van</span><strong>{activity.totals.vanCount}</strong><small>{money(activity.totals.vanAmount)}</small></article>
          <article className="da"><span>Adhoc DA</span><strong>{activity.totals.daCount}</strong><small>{money(activity.totals.daAmount)} · includes Adhoc Driver</small></article>
          <article><span>Total jobs</span><strong>{activity.totals.totalCount}</strong><small>{activity.totals.activeStations} of {selectedLocations.length} stations</small></article>
          <article className="total"><span>Total amount</span><strong>{money(activity.totals.totalAmount)}</strong><small>{periodName}</small></article>
        </section>

        <section className="panel cps-adhoc-stations">
          <div className="panel-head"><div><h2>Station summary</h2><p className="subtle">Every selected station is shown. Click a station with activity to open its daily breakup.</p></div><span>{selectedLocations.length} stations</span></div>
          <CpsAdHocTable stations={activity.stations} />
          <footer className="cps-adhoc-source-note">Counts include approved, processing and processed requests. Pending, returned and rejected requests are excluded.</footer>
        </section>
      </div>
    </AppShell>
  );
}
