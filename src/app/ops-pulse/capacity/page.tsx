
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { CapacityScopeFilter } from "@/components/capacity-scope-filter";
import { CapacityViewTabs } from "@/components/capacity-view-tabs";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { allowedCapacityViewTabs, allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import { loadCapacitySnapshot, type CapacityStationSnapshot } from "@/lib/ops-pulse/capacity-snapshot";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";

export const dynamic = "force-dynamic";

type SearchParams = { stations?: string; sort?: string; dir?: string };

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function fmt(value: number, digits = 0) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function scopeCodes(value: string | undefined, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = value.split(",").map((code) => code.trim().toUpperCase());
  return allowed.filter((code) => requested.includes(code));
}

function decisionTone(row: CapacityStationSnapshot) {
  if (row.dataState !== "ready" || row.decision.status === "unconfigured") return "unconfigured";
  if (row.decision.status === "hire_candidate" || row.decision.status === "temporary_surge") return "risk";
  if (row.decision.status === "monitor" || row.decision.status === "flex") return "warn";
  if (row.decision.status === "surplus") return "surplus";
  return "balanced";
}

export default async function CapacityPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_overview", "access");
  const companyId = requireCompanyId(authorization);
  const workspaceTabs = allowedCapacityWorkspaceTabs(authorization);
  const viewTabs = allowedCapacityViewTabs(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permittedLocations = locationResult.locations.filter(isAmazonEdspXptLocation);
  const selectedCodes = scopeCodes(searchParams?.stations, permittedLocations.map((location) => location.station_code));
  const locations = permittedLocations.filter((location) => selectedCodes.includes(location.station_code));
  const reportingDate = dateShift(today(), -1);
  const snapshot = await loadCapacitySnapshot({ companyId, locations, reportingDate });
  const allowedSorts = new Set(["station", "freshness", "workload", "spr", "required", "gap", "confidence", "decision"]);
  const sort = allowedSorts.has(String(searchParams?.sort)) ? String(searchParams?.sort) : "decision";
  const dir = searchParams?.dir === "asc" ? "asc" : "desc";
  const priority: Record<string, number> = {
    hire_candidate: 8,
    temporary_surge: 7,
    monitor: 5,
    flex: 4,
    unconfigured: 3,
    no_data: 2,
    surplus: 1,
    balanced: 0
  };
  const sortValue = (row: CapacityStationSnapshot) => {
    if (sort === "station") return row.stationCode;
    if (sort === "freshness") return row.freshnessDays ?? 999;
    if (sort === "workload") return row.averageWorkload;
    if (sort === "spr") return row.spr;
    if (sort === "required") return row.requiredIds ?? -1;
    if (sort === "gap") return row.modelledGap ?? -999;
    if (sort === "confidence") return { high: 3, medium: 2, low: 1 }[row.decision.confidence];
    return priority[row.decision.status] ?? 0;
  };
  const stations = [...snapshot.stations].sort((left, right) => {
    const a = sortValue(left);
    const b = sortValue(right);
    const comparison = typeof a === "string" ? a.localeCompare(String(b)) : Number(a) - Number(b);
    return dir === "asc" ? comparison : -comparison;
  });
  const actionQueue = [...snapshot.stations]
    .filter((row) => priority[row.decision.status] >= 3 || row.dataState !== "ready")
    .sort((a, b) => {
      const score = (row: CapacityStationSnapshot) =>
        (row.dataState !== "ready" ? 1000 : priority[row.decision.status] * 100)
        + Math.max(0, row.modelledGap ?? 0);
      return score(b) - score(a);
    })
    .slice(0, 8);
  const sortHref = (key: string) => {
    const params = new URLSearchParams();
    if (searchParams?.stations) params.set("stations", searchParams.stations);
    params.set("sort", key);
    params.set("dir", sort === key && dir === "desc" ? "asc" : "desc");
    return `/ops-pulse/capacity?${params.toString()}`;
  };
  const sortMark = (key: string) => sort === key ? (dir === "asc" ? "↑" : "↓") : "↕";
  const scopeStations = permittedLocations.map((location) => ({
    code: location.station_code,
    name: location.station_name || location.city || location.station_code,
    cluster: location.cluster || "",
    region: location.region || ""
  }));
  const totalActiveIds = snapshot.stations.reduce((sum, row) => sum + row.latestSystemIds, 0);
  const totalAverageWorkload = snapshot.stations.reduce((sum, row) => sum + row.averageWorkload, 0);
  const totalRequiredIds = snapshot.stations.reduce((sum, row) => sum + (row.requiredIds ?? 0), 0);
  const error = [locationResult.error, ...snapshot.errors].filter(Boolean).join(" · ");

  return <AppShell active="Capacity" pageCode="capacity_overview"><div className="ops-command-center capacity-workspace capacity-control-tower capacity-simple">
    <PageHead eyebrow="Workforce Planning" title="Capacity" subtitle="Workload, available associates and the stations that need attention." />
    <div className="capacity-tabs-toolbar"><CapacityWorkspaceTabs active="overview" allowed={workspaceTabs} /><CapacityScopeFilter selectedCodes={selectedCodes} stations={scopeStations}/></div>
    <CapacityViewTabs active="operations" allowed={viewTabs} />
    {error ? <div className="message-panel error">{error}</div> : null}

    <section className={`capacity-simple-status ${snapshot.summary.stale ? "warning" : "ready"}`}>
      <span className="capacity-simple-status-dot"/>
      <strong>{snapshot.summary.stale ? `${snapshot.summary.stale} station${snapshot.summary.stale === 1 ? "" : "s"} need a data refresh` : "Workload data is current"}</strong>
      <span>As of {snapshot.scopeDataDate ? snapshot.scopeDataDate.split("-").reverse().join("/") : "—"}</span>
      <span>{snapshot.scopeCoverage}% coverage</span>
    </section>

    <section className="capacity-simple-kpis">
      <article><span>Average daily workload</span><strong>{fmt(totalAverageWorkload)}</strong><small>Last 14 completed days</small></article>
      <article><span>Amazon IDs used</span><strong>{fmt(totalActiveIds)}</strong><small>{fmt(snapshot.summary.externalDAs)} operated by external DAs</small></article>
      <article><span>Average SPR</span><strong>{fmt(snapshot.summary.averageSpr, 1)}</strong><small>Workload per active associate</small></article>
      <article><span>Required associates</span><strong>{fmt(totalRequiredIds)}</strong><small>At configured station targets</small></article>
    </section>

    <section className="panel capacity-simple-priorities">
      <div className="panel-head"><div><h2>Priority stations</h2><p className="subtle">The stations to review first.</p></div><a href="/ops-pulse/capacity/hiring">Open hiring review →</a></div>
      <div className="capacity-simple-priority-list">
        {actionQueue.slice(0, 6).map((row) => <a href={`/ops-pulse/capacity/${row.stationCode}?from=${snapshot.from}&to=${reportingDate}`} key={row.stationCode}>
          <span className={`capacity-action-code ${decisionTone(row)}`}>{row.stationCode}</span>
          <span><strong>{row.stationName}</strong><small>{row.cluster || row.region || "—"}</small></span>
          <span className="capacity-simple-priority-metric"><strong>{row.modelledGap == null ? "—" : `${row.modelledGap > 0 ? "+" : ""}${row.modelledGap}`}</strong><small>associate gap</small></span>
          <span className={`capacity-decision ${decisionTone(row)}`}>{row.dataState !== "ready" ? "Refresh data" : row.decision.label}</span>
          <b>›</b>
        </a>)}
        {!actionQueue.length ? <p className="empty-cell">No stations require attention.</p> : null}
      </div>
    </section>

    <section className="panel capacity-simple-stations">
      <div className="panel-head"><div><h2>All stations</h2><p className="subtle">{snapshot.summary.stations} stations · open a station for daily and associate detail.</p></div><a className="button secondary compact" href="/master/capacity">Capacity Master</a></div>
      <div className="table-wrap"><ReportTable className="capacity-table capacity-simple-table"><thead><tr>
        <th><a href={sortHref("station")}>Station {sortMark("station")}</a></th>
        <th><a href={sortHref("workload")}>Avg workload {sortMark("workload")}</a></th>
        <th>DA mix</th>
        <th><a href={sortHref("spr")}>SPR {sortMark("spr")}</a></th>
        <th><a href={sortHref("required")}>Required {sortMark("required")}</a></th>
        <th><a href={sortHref("gap")}>Gap {sortMark("gap")}</a></th>
        <th><a href={sortHref("decision")}>Status {sortMark("decision")}</a></th>
      </tr></thead><tbody>
        {stations.map((row) => <tr key={row.stationCode}>
          <td><a className="capacity-station-link" href={`/ops-pulse/capacity/${row.stationCode}?from=${snapshot.from}&to=${reportingDate}`}><strong>{row.stationCode}</strong><small>{row.stationName} · {row.cluster || row.region || "—"}</small></a></td>
          <td><strong>{fmt(row.averageWorkload)}</strong></td>
          <td><strong>{fmt(row.latestInternalDAs)} internal / {fmt(row.latestExternalDAs)} external</strong><small>{fmt(row.latestSystemIds)} Amazon IDs used</small></td>
          <td><strong className={row.maxSafeSpr && row.spr > row.maxSafeSpr ? "metric-bad-text" : ""}>{row.averageWorkload ? fmt(row.spr, 1) : "—"}</strong><small>{row.targetSpr ? `Target ${fmt(row.targetSpr, 1)}` : "Target pending"}</small></td>
          <td>{row.requiredIds ?? "—"}</td>
          <td><strong className={(row.modelledGap ?? 0) > 0 ? "metric-bad-text" : (row.modelledGap ?? 0) < -1 ? "metric-warn-text" : "metric-good-text"}>{row.modelledGap == null ? "—" : `${row.modelledGap > 0 ? "+" : ""}${row.modelledGap}`}</strong></td>
          <td><span className={`capacity-decision ${decisionTone(row)}`}>{row.dataState !== "ready" ? "Refresh data" : row.decision.label}</span></td>
        </tr>)}
        {!stations.length ? <tr><td className="empty-cell" colSpan={7}>No permitted stations are selected.</td></tr> : null}
      </tbody></ReportTable></div>
    </section>
  </div></AppShell>;
}
