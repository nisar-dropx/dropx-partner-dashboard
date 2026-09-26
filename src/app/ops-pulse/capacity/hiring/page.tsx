import { AppShell } from "@/components/app-shell";
import { CapacityAiAction, CapacityAiActionProvider, type CapacityAiFact } from "@/components/capacity-ai-actions";
import { CapacityScopeFilter } from "@/components/capacity-scope-filter";
import { CapacityViewTabs } from "@/components/capacity-view-tabs";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { allowedCapacityViewTabs, allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import { loadApprovedCapacityAdHocUsage } from "@/lib/ops-pulse/capacity-ad-hoc";
import { loadCapacityRules } from "@/lib/ops-pulse/capacity";
import { buildCapacityPlanningDecision, type CapacityPlanningDecision } from "@/lib/ops-pulse/capacity-decision";
import { loadCapacityAssociateDays, loadCapacityStationDays } from "@/lib/ops-pulse/capacity-shipments";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";

export const dynamic = "force-dynamic";

type SearchParams = { station?: string; stations?: string; from?: string; to?: string; alert?: string; sort?: string; dir?: string };
type CapacityView = CapacityPlanningDecision & { stationName: string };

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function num(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }
function validDate(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function averageAmazonIds(row: CapacityPlanningDecision) {
  const operatingDays = row.daily.filter((day) => day.workload > 0 && day.systemIds > 0);
  return operatingDays.length
    ? operatingDays.reduce((sum, day) => sum + day.systemIds, 0) / operatingDays.length
    : 0;
}
function scopeCodes(value: string | undefined, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = value.split(",").map((code) => code.trim().toUpperCase());
  return allowed.filter((code) => requested.includes(code));
}
function decisionClass(status: CapacityPlanningDecision["status"]) {
  if (status === "hire_candidate") return "hire";
  if (status === "temporary_surge" || status === "monitor" || status === "flex") return "surplus";
  if (status === "balanced") return "balanced";
  if (status === "surplus") return "unconfigured";
  return "no_data";
}

export default async function CapacityPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_hiring", "access");
  const companyId = requireCompanyId(authorization);
  const workspaceTabs = allowedCapacityWorkspaceTabs(authorization);
  const viewTabs = allowedCapacityViewTabs(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permittedLocations = locationResult.locations.filter(isAmazonEdspXptLocation);
  const selectedCodes = scopeCodes(searchParams?.stations, permittedLocations.map((location) => location.station_code));
  const locations = permittedLocations.filter((location) => selectedCodes.includes(location.station_code));
  const codes = locations.map((location) => location.station_code);
  const reportingDate = dateShift(today(), -1);
  const baselineFrom = dateShift(reportingDate, -30);
  const selectedStationCode = codes.includes(String(searchParams?.station ?? "").toUpperCase()) ? String(searchParams?.station).toUpperCase() : null;
  const detailFrom = validDate(searchParams?.from) ? String(searchParams?.from) : dateShift(reportingDate, -13);
  const detailTo = validDate(searchParams?.to) ? String(searchParams?.to) : reportingDate;
  const sourceFrom = detailFrom < baselineFrom ? detailFrom : baselineFrom;
  const sort = ["station", "base", "regular", "gap", "flex", "classified", "confidence", "decision"].includes(String(searchParams?.sort)) ? String(searchParams?.sort) : "decision";
  const dir = searchParams?.dir === "asc" ? "asc" : "desc";

  const [ruleResult, baselineResult, associateResult, reviewResult] = await Promise.all([
    loadCapacityRules(companyId),
    loadCapacityStationDays(companyId, codes, baselineFrom, reportingDate),
    selectedStationCode
      ? loadCapacityAssociateDays(companyId, [selectedStationCode], detailFrom, detailTo)
      : Promise.resolve({ data: [], error: null }),
    loadApprovedCapacityAdHocUsage(companyId, sourceFrom, reportingDate)
  ]);
  const rules = new Map(ruleResult.rows.map((rule) => [rule.stationCode, rule]));
  const baselineRows = baselineResult.data ?? [];
  const approvedAdHoc = reviewResult.rows;
  const views: CapacityView[] = locations.map((location) => ({
    ...buildCapacityPlanningDecision({
      stationCode: location.station_code,
      rows: baselineRows,
      adHocUsage: approvedAdHoc,
      rule: rules.get(location.station_code)
    }),
    stationName: location.station_name || location.city || location.station_code
  }));

  const sortValue = (row: CapacityView) => {
    if (sort === "station") return row.stationCode;
    if (sort === "base") return row.baseWorkload;
    if (sort === "regular") return row.internalCapacity;
    if (sort === "gap") return row.permanentGap ?? -999;
    if (sort === "flex") return row.peakFlex;
    if (sort === "classified") return row.classifiedDays;
    if (sort === "confidence") return { low: 0, medium: 1, high: 2 }[row.confidence];
    return { hire_candidate: 9, temporary_surge: 7, monitor: 6, flex: 5, surplus: 4, balanced: 3, unconfigured: 2, no_data: 1 }[row.status];
  };
  views.sort((left, right) => {
    const a = sortValue(left);
    const b = sortValue(right);
    const compared = typeof a === "string" ? a.localeCompare(String(b)) : Number(a) - Number(b);
    return dir === "asc" ? compared : -compared;
  });
  const sortParams = new URLSearchParams();
  if (searchParams?.stations) sortParams.set("stations", searchParams.stations);
  const sortHref = (key: string) => {
    const params = new URLSearchParams(sortParams);
    params.set("sort", key);
    params.set("dir", sort === key && dir === "desc" ? "asc" : "desc");
    return `/ops-pulse/capacity/hiring?${params.toString()}`;
  };
  const sortMark = (key: string) => sort === key ? (dir === "desc" ? "↓" : "↑") : "↕";
  const scopeStations = permittedLocations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code, cluster: location.cluster || "", region: location.region || "" }));
  const selectedStation = selectedStationCode ? views.find((row) => row.stationCode === selectedStationCode) ?? null : null;
  const selectedAlert = selectedStation?.alerts.find((alert) => alert.id === searchParams?.alert) ?? null;
  const alerts = views.flatMap((row) => row.alerts)
    .filter((alert) => alert.date === reportingDate)
    .sort((a, b) =>
    Number(b.severity === "critical") - Number(a.severity === "critical") || b.date.localeCompare(a.date)
  );
  const aiDefaults = Object.fromEntries(views.map((row) => [row.stationCode, row.action]));
  const aiFacts: CapacityAiFact[] = views.map((row) => {
    const averageIds = averageAmazonIds(row);
    return {
      stationCode: row.stationCode,
      systemIds: row.latestSystemIds,
      internalDAs: row.internalCapacity,
      externalDAs: row.daily.at(-1)?.externalDAs ?? 0,
      averageDelivered: Number(row.baseWorkload.toFixed(1)),
      averageInbound: 0,
      spr: averageIds ? Number((row.baseWorkload / averageIds).toFixed(1)) : 0,
      targetSpr: rules.get(row.stationCode)?.targetSpr ?? null,
      maxSafeSpr: rules.get(row.stationCode)?.maxSafeSpr ?? null,
      requiredIds: row.permanentRequired,
      gap: row.permanentGap,
      status: row.status,
      sourceDays: row.classifiedDays,
      baselineDays: row.baselineDays,
      peakFlex: row.peakFlex,
      confidence: row.confidence,
      sustainedShortage: row.sustainedShortage
    };
  });

  const hireCandidates = views.filter((row) => row.status === "hire_candidate");
  const permanentPositions = hireCandidates.reduce((sum, row) => sum + Math.max(0, Math.ceil(row.permanentGap ?? 0)), 0);
  const flexPositions = views.reduce((sum, row) => sum + row.peakFlex, 0);
  const observationCount = views.filter((row) => row.status === "monitor" || row.status === "temporary_surge").length;
  const latestExternalDAs = views.reduce((sum, row) => sum + (row.daily.at(-1)?.externalDAs ?? 0), 0);
  const selectedAssociateRows = associateResult.data ?? [];
  const associateIds = [...new Set(selectedAssociateRows.map((row) => row.associate_id).filter(Boolean))];
  const associateDetail = associateIds.map((associateId) => {
    const rows = selectedAssociateRows.filter((row) => row.associate_id === associateId);
    const dates = [...new Set(rows.map((row) => row.work_date))].sort();
    const daily = dates.map((date) => rows.filter((row) => row.work_date === date).reduce((sum, row) => sum + num(row.delivered), 0));
    const workload = daily.reduce((sum, value) => sum + value, 0);
    return { associateId, days: dates.length, workload, average: dates.length ? workload / dates.length : 0, peak: Math.max(0, ...daily) };
  }).sort((a, b) => b.average - a.average);
  const selectedDaily = selectedStation?.daily.filter((day) => day.date >= detailFrom && day.date <= detailTo) ?? [];
  const maxDailyWorkload = Math.max(1, ...selectedDaily.map((day) => day.workload));
  const error = locationResult.error || ruleResult.error || baselineResult.error?.message || associateResult.error?.message || reviewResult.error;

  return <AppShell active="Capacity" pageCode="capacity_hiring"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Workforce Planning" title="Capacity" subtitle="Amazon ID usage with internal and approved external DA coverage." action={<a className="button compact" href="/work-force-register?status=pending">Workforce pending</a>} />
    <div className="capacity-tabs-toolbar"><CapacityWorkspaceTabs active="overview" allowed={workspaceTabs} /><CapacityScopeFilter selectedCodes={codes} stations={scopeStations}/></div>
    <CapacityViewTabs active="hiring" allowed={viewTabs} />
    <div className="capacity-basis-strip"><strong>Planning cycle</strong><span>Amazon IDs stay unchanged · approved external DAs classify who operated those IDs · internal DA coverage = total IDs − external DAs</span></div>
    {error ? <div className="message-panel error">{error}</div> : null}

    <section className="performance-summary-grid capacity-decision-summary">
      <article><span>Hire candidates</span><strong>{hireCandidates.length}</strong><small>{permanentPositions} sustained positions</small></article>
      <article><span>Peak flex</span><strong>{flexPositions}</strong><small>Temporary resources across scope</small></article>
      <article><span>Under observation</span><strong>{observationCount}</strong><small>Not cleared for hiring</small></article>
      <article><span>Active alerts</span><strong>{alerts.length}</strong><small>DA drops, spikes and payment mismatches</small></article>
      <article><span>External DAs</span><strong>{latestExternalDAs}</strong><small>Approved replacements on latest completed day</small></article>
    </section>

    {alerts.length ? <section className="panel capacity-alert-center" id="capacity-alerts"><div className="panel-head"><div><span className="eyebrow">Capacity alerts</span><h2>Recent exceptions</h2><p className="subtle">Select an alert to open the station evidence and affected date.</p></div><span className="status-pill warn">{alerts.length} active</span></div><div className="capacity-alert-list">
      {alerts.slice(0, 12).map((alert) => <a className={`capacity-alert-item ${alert.severity}`} href={`/ops-pulse/capacity/hiring?station=${alert.stationCode}&from=${dateShift(alert.date, -6)}&to=${alert.date}&alert=${encodeURIComponent(alert.id)}${searchParams?.stations ? `&stations=${encodeURIComponent(searchParams.stations)}` : ""}#station-detail`} key={alert.id}><span>{alert.type === "associate_drop" ? "DA" : alert.type === "volume_spike" ? "VOL" : "PAY"}</span><div><strong>{alert.stationCode} · {alert.title}</strong><small>{alert.detail}</small></div><time>{alert.date.split("-").reverse().join("/")}</time><b>View ›</b></a>)}
    </div></section> : null}

    <CapacityAiActionProvider defaults={aiDefaults} facts={aiFacts}><section className="panel"><div className="panel-head"><div><h2>Station hiring plan</h2><p className="subtle">Internal DA coverage excludes approved external replacements from the unchanged Amazon ID total.</p></div><div className="capacity-panel-actions"><a className="button secondary compact" href="/master/capacity">Capacity Master</a></div></div>
      <div className="table-wrap"><table className="capacity-table capacity-decision-table"><thead><tr>
        <th><a href={sortHref("station")}>Station {sortMark("station")}</a></th>
        <th><a href={sortHref("base")}>14-day base {sortMark("base")}</a></th>
        <th><a href={sortHref("regular")}>Internal DA capacity {sortMark("regular")}</a></th>
        <th><a href={sortHref("gap")}>Permanent gap {sortMark("gap")}</a></th>
        <th><a href={sortHref("flex")}>Peak flex {sortMark("flex")}</a></th>
        <th><a href={sortHref("classified")}>Source days {sortMark("classified")}</a></th>
        <th><a href={sortHref("confidence")}>Confidence {sortMark("confidence")}</a></th>
        <th><a href={sortHref("decision")}>Decision {sortMark("decision")}</a></th>
        <th>Action</th>
      </tr></thead><tbody>
        {views.map((row) => <tr key={row.stationCode}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/hiring?station=${row.stationCode}&from=${detailFrom}&to=${detailTo}${searchParams?.stations ? `&stations=${encodeURIComponent(searchParams.stations)}` : ""}#station-detail`}><strong>{row.stationCode}</strong><small>{row.stationName}</small></a></td><td><strong>{fmt(row.baseWorkload)}</strong><small>{row.sourceDays}/{row.baselineDays} completed days</small></td><td><strong>{fmt(row.internalCapacity, 1)}</strong><small>{row.internalCapacitySource === "payment_adjusted" ? "External DA adjusted median" : row.internalCapacitySource === "system" ? "All IDs internally operated" : "No source"}</small></td><td><strong className={(row.permanentGap ?? 0) > 0 ? "metric-bad-text" : "metric-good-text"}>{row.permanentGap == null ? "—" : row.permanentGap > 0 ? `+${fmt(row.permanentGap, 1)}` : fmt(row.permanentGap, 1)}</strong><small>{row.permanentRequired == null ? "Master pending" : `${row.permanentRequired} required`}</small></td><td>{row.peakFlex ? `+${row.peakFlex}` : "—"}<small>{row.peakRequired ? `${row.peakRequired} at P90` : ""}</small></td><td><strong>{row.classifiedDays}/{row.baselineDays}</strong><small>{row.adHocDays} with external DA cover</small></td><td><span className={`capacity-confidence ${row.confidence}`}>{row.confidence}</span></td><td><span className={`capacity-decision ${decisionClass(row.status)}`}>{row.label}</span></td><td><CapacityAiAction stationCode={row.stationCode}/></td></tr>)}
        {!views.length ? <tr><td className="empty-cell" colSpan={9}>No permitted stations are available.</td></tr> : null}
      </tbody></table></div>
    </section></CapacityAiActionProvider>

    {selectedStation ? <section className="panel capacity-detail" id="station-detail">
      <div className="panel-head"><div><span className="eyebrow">Hiring evidence</span><h2>{selectedStation.stationCode} · {selectedStation.stationName}</h2><p className="subtle">{selectedStation.sourceDays} completed days · {selectedStation.adHocDays} days with approved external DA cover · {selectedStation.shortageDays} shortage days</p></div><a className="button secondary compact" href={`/ops-pulse/capacity/hiring${searchParams?.stations ? `?stations=${encodeURIComponent(searchParams.stations)}` : ""}`}>Close</a></div>
      {selectedAlert ? <div className={`capacity-selected-alert ${selectedAlert.severity}`}><strong>{selectedAlert.title}</strong><span>{selectedAlert.detail}</span></div> : null}
      <div className="capacity-action-line"><strong>{selectedStation.label}</strong><span>{selectedStation.action}</span></div>
      <section className="capacity-detail-kpis"><article><span>Stable workload</span><strong>{fmt(selectedStation.baseWorkload)}</strong><small>Trimmed {selectedStation.baselineDays}-day average</small></article><article><span>Internal DA capacity</span><strong>{fmt(selectedStation.internalCapacity, 1)}</strong><small>Amazon IDs used minus external DAs</small></article><article><span>Permanent requirement</span><strong>{selectedStation.permanentRequired ?? "—"}</strong><small>{selectedStation.sustainedShortage ? "Both review cycles short" : "Not sustained across both cycles"}</small></article><article><span>Peak flex</span><strong>{selectedStation.peakFlex}</strong><small>P90 workload {fmt(selectedStation.peakWorkload)}</small></article></section>
      <form className="capacity-detail-filter" method="get"><input type="hidden" name="station" value={selectedStation.stationCode}/><input type="hidden" name="stations" value={searchParams?.stations ?? ""}/><label>From<input type="date" name="from" defaultValue={detailFrom}/></label><label>To<input type="date" name="to" defaultValue={detailTo}/></label><button className="button compact" type="submit">Apply</button></form>
      {selectedDaily.length ? <div className="capacity-detail-grid"><div className="capacity-trend" aria-label="Daily workload trend">{selectedDaily.map((day) => <div className="capacity-trend-column" key={day.date} title={`${day.date}: ${fmt(day.workload)} workload, ${day.systemIds} Amazon IDs used`}><span>{fmt(day.workload)}</span><i className={day.alerts.length ? "risk" : ""} style={{ height: `${Math.max(4, day.workload / maxDailyWorkload * 100)}%` }}/><small>{day.date.slice(8)}</small></div>)}</div><div className="table-wrap"><table className="capacity-daily-table capacity-evidence-table"><thead><tr><th>Date</th><th>Amazon IDs used</th><th>Internal DAs</th><th>External DAs</th><th>Approved requests</th><th>Workload</th><th>Required internal DAs</th><th>Internal gap</th><th>SPR</th><th>Alert</th></tr></thead><tbody>{selectedDaily.map((day) => {
        const gap = day.required != null ? day.required - day.internalDAs : null;
        return <tr className={day.alerts.length ? "capacity-alert-day" : ""} key={day.date}><td>{day.date.split("-").reverse().join("/")}</td><td>{day.systemIds}</td><td>{day.internalDAs}</td><td>{day.externalDAs}</td><td>{day.paymentRequests || "—"}</td><td>{fmt(day.workload)}</td><td>{day.required ?? "—"}</td><td className={(gap ?? 0) > 0 ? "metric-bad-text" : ""}>{gap == null ? "—" : gap > 0 ? `+${gap}` : gap}</td><td>{fmt(day.spr, 1)}</td><td>{day.alerts.length ? day.alerts.map((alert) => alert.type === "associate_drop" ? "Internal DA drop" : alert.type === "volume_spike" ? "Volume spike" : "Payment mismatch").join(", ") : "—"}</td></tr>;
      })}</tbody></table></div></div> : <div className="empty-state">No completed workload is available in this range.</div>}
      {associateDetail.length ? <div className="capacity-associate-section"><div className="capacity-section-title"><div><h3>Associate workload detail</h3><p>Supporting evidence for the selected review period.</p></div><span>{associateDetail.length} associates</span></div><div className="table-wrap"><table className="capacity-daily-table"><thead><tr><th>Associate ID</th><th>Active days</th><th>Total workload</th><th>Average/day</th><th>Peak</th></tr></thead><tbody>{associateDetail.map((associate) => <tr key={associate.associateId}><td><a href={`/ops-pulse/capacity/associates/${encodeURIComponent(associate.associateId)}?station=${selectedStation.stationCode}&from=${detailFrom}&to=${detailTo}`}><strong>{associate.associateId}</strong></a></td><td>{associate.days}</td><td>{fmt(associate.workload)}</td><td>{fmt(associate.average, 1)}</td><td>{fmt(associate.peak)}</td></tr>)}</tbody></table></div></div> : null}
    </section> : null}
  </div></AppShell>;
}
