import { AppShell } from "@/components/app-shell";
import { CapacityAssociateViewTabs } from "@/components/capacity-associate-view-tabs";
import { CapacityScopeFilter } from "@/components/capacity-scope-filter";
import { CapacityAssociateFilters } from "@/components/capacity-associate-filters";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import { loadCapacityRules } from "@/lib/ops-pulse/capacity";
import { loadShipmentCountAssociateDays } from "@/lib/ops-pulse/capacity-shipments";
import { officialAssociateDeliveryCount } from "@/lib/ops-pulse/associate-delivery-count";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { associateIdentityKey, isScientificAssociateId, normalizeAssociateName } from "@/lib/ops-pulse/associate-identity";

export const dynamic = "force-dynamic";
type SearchParams = { from?: string; to?: string; preset?: string; station?: string; stations?: string; band?: string; sort?: string; dir?: string; view?: string; page?: string };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function shift(value: string, days: number) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function yesterday() { return shift(today(), -1); }
function valid(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }
function scopeCodes(value: string | undefined, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = value.split(",").map((code) => code.trim().toUpperCase());
  return allowed.filter((code) => requested.includes(code));
}

export default async function SprAssociatesPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_associates", "access");
  const companyId = requireCompanyId(authorization);
  const workspaceTabs = allowedCapacityWorkspaceTabs(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationResult.locations.filter(isAmazonEdspXptLocation);
  const requestedStation = String(searchParams?.station ?? "").trim().toUpperCase();
  const selectedStation = locations.some((location) => location.station_code === requestedStation) ? requestedStation : "";
  const selectedCodes = selectedStation ? [selectedStation] : scopeCodes(searchParams?.stations, locations.map((location) => location.station_code));
  const queryLocations = locations.filter((location) => selectedCodes.includes(location.station_code));
  const band = ["all", "low", "target", "high"].includes(String(searchParams?.band)) ? String(searchParams?.band) : "all";
  const activeView = searchParams?.view === "recommendations" ? "recommendations" : "productivity";
  const sort = ["name", "average", "peak", "delivered", "days", "highDays", "station", "level"].includes(String(searchParams?.sort)) ? String(searchParams?.sort) : "average";
  const dir = searchParams?.dir === "asc" ? "asc" : "desc";
  const end = valid(searchParams?.to) ? String(searchParams?.to) : yesterday();
  const preset = ["yesterday", "wtd", "mtd", "ytd", "custom"].includes(String(searchParams?.preset)) ? String(searchParams?.preset) : "yesterday";
  const weekday = new Date(`${end}T00:00:00Z`).getUTCDay();
  const start = preset === "custom" && valid(searchParams?.from) ? String(searchParams?.from)
    : preset === "yesterday" ? end
    : preset === "wtd" ? shift(end, -((weekday + 6) % 7))
    : preset === "ytd" ? `${end.slice(0, 4)}-01-01` : `${end.slice(0, 8)}01`;
  const [ruleResult, associateResult] = await Promise.all([
    loadCapacityRules(companyId),
    loadShipmentCountAssociateDays(companyId, queryLocations.map((location) => location.station_code), start, end)
  ]);
  const rows = associateResult.data ?? [];
  const ruleMap = new Map(ruleResult.rows.map((rule) => [rule.stationCode, rule]));
  const aggregateMap = new Map<string, { stationCode: string; id: string; name: string; daily: Map<string, number>; delivered: number }>();
  rows.forEach((row) => {
    const associateId = String(row.provider_employee_id ?? "").trim();
    if (!associateId) return;
    const key = associateIdentityKey(row.station_code, associateId, row.provider_employee_name);
    const current = aggregateMap.get(key) ?? {
      stationCode: row.station_code,
      id: associateId,
      name: row.provider_employee_name || "Unmapped name",
      daily: new Map<string, number>(),
      delivered: 0
    };
    const delivered = officialAssociateDeliveryCount(row.amazon_delivery);
    current.delivered += delivered;
    current.daily.set(row.work_date, (current.daily.get(row.work_date) ?? 0) + delivered);
    if (current.name === "Unmapped name" && row.provider_employee_name) current.name = row.provider_employee_name;
    aggregateMap.set(key, current);
  });
  const personMap = new Map<string, { stationCode: string; id: string; name: string; daily: Map<string, number> }>();
  aggregateMap.forEach((aggregate) => {
    const normalizedName = normalizeAssociateName(aggregate.name);
    const personKey = normalizedName && aggregate.name !== "Unmapped name"
      ? `${aggregate.stationCode}|${normalizedName}`
      : associateIdentityKey(aggregate.stationCode, aggregate.id, null);
    const current = personMap.get(personKey) ?? {
      stationCode: aggregate.stationCode,
      id: aggregate.id,
      name: aggregate.name,
      daily: new Map<string, number>()
    };
    aggregate.daily.forEach((value, date) => current.daily.set(date, Math.max(current.daily.get(date) ?? 0, value)));
    if (isScientificAssociateId(current.id) && !isScientificAssociateId(aggregate.id)) current.id = aggregate.id;
    personMap.set(personKey, current);
  });
  const allAssociates = [...personMap.values()].map((aggregate) => {
    const daily = [...aggregate.daily.values()];
    const delivered = daily.reduce((sum, value) => sum + value, 0);
    const average = daily.length ? delivered / daily.length : 0;
    const rule = ruleMap.get(aggregate.stationCode);
    const target = rule?.targetSpr ?? null;
    const safe = rule?.maxSafeSpr ?? null;
    const level = target == null || safe == null ? "unconfigured" : average > safe ? "high" : average < target ? "low" : "target";
    const highDays = safe == null ? 0 : daily.filter((value) => value > safe).length;
    const evidenceReady = daily.length >= 3;
    const recommendation = target == null || safe == null
      ? { label: "Target required", tone: "unconfigured", action: "Configure station SPR targets before reviewing this associate." }
      : !evidenceReady
        ? { label: "Observe", tone: "neutral", action: `Only ${daily.length} active day${daily.length === 1 ? "" : "s"} available; wait for at least 3 days before action.` }
        : level === "high"
          ? { label: "Reduce allocation", tone: "risk", action: `Rebalance ${fmt(average - safe, 1)} Amazon deliveries/day away from this route and review repeated high-allocation days.` }
          : level === "low"
            ? { label: "Allocation review", tone: "warn", action: `Review route allocation, attendance and available volume; average is ${fmt(target - average, 1)} below target.` }
            : highDays > 0
              ? { label: "Monitor peaks", tone: "warn", action: `${highDays} high-allocation day${highDays === 1 ? "" : "s"} occurred despite an in-range average; inspect the daily route mix.` }
              : { label: "Maintain", tone: "balanced", action: "Allocation is within the configured target-to-safe range; maintain and monitor." };
    return {
      stationCode: aggregate.stationCode,
      id: aggregate.id,
      name: aggregate.name,
      dates: daily.length,
      delivered,
      average,
      peak: Math.max(0, ...daily),
      highDays,
      target,
      safe,
      level,
      evidenceReady,
      recommendation
    };
  });
  const filteredAssociates = allAssociates.filter((row) => band === "all" || row.level === band);
  const sortValue = (row: typeof allAssociates[number]) => sort === "name" ? row.name : sort === "peak" ? row.peak : sort === "delivered" ? row.delivered : sort === "days" ? row.dates : sort === "highDays" ? row.highDays : sort === "station" ? row.stationCode : sort === "level" ? row.level : row.average;
  const associates = filteredAssociates.sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    const compared = typeof left === "string" ? left.localeCompare(String(right)) : Number(left) - Number(right);
    return dir === "asc" ? compared : -compared;
  });
  const pageSize = 100;
  const pageCount = Math.max(1, Math.ceil(associates.length / pageSize));
  const currentPage = Math.min(pageCount, Math.max(1, Number.parseInt(String(searchParams?.page ?? "1"), 10) || 1));
  const shownAssociates = associates.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const lowCount = allAssociates.filter((row) => row.level === "low").length;
  const targetCount = allAssociates.filter((row) => row.level === "target").length;
  const highCount = allAssociates.filter((row) => row.level === "high").length;
  const limitedEvidenceCount = allAssociates.filter((row) => !row.evidenceReady).length;
  const locationNameMap = new Map(locations.map((location) => [location.station_code, location.station_name || location.city || location.station_code]));
  const stationRecommendations = queryLocations.map((location) => {
    const stationCode = location.station_code;
    const stationAssociates = allAssociates.filter((row) => row.stationCode === stationCode);
    const totalWorkload = stationAssociates.reduce((sum, row) => sum + row.delivered, 0);
    const activeDays = stationAssociates.reduce((sum, row) => sum + row.dates, 0);
    const average = activeDays ? totalWorkload / activeDays : 0;
    const high = stationAssociates.filter((row) => row.level === "high" && row.evidenceReady).length;
    const low = stationAssociates.filter((row) => row.level === "low" && row.evidenceReady).length;
    const inRange = stationAssociates.filter((row) => row.level === "target" && row.evidenceReady).length;
    const observing = stationAssociates.filter((row) => !row.evidenceReady).length;
    const evidenceReady = stationAssociates.length - observing;
    const rule = ruleMap.get(stationCode);
    const target = rule?.targetSpr ?? null;
    const safe = rule?.maxSafeSpr ?? null;
    const highShare = stationAssociates.length ? high / stationAssociates.length : 0;
    const lowShare = stationAssociates.length ? low / stationAssociates.length : 0;
    const recommendation = !stationAssociates.length
      ? { label: "No data", tone: "neutral", rank: 0, action: "No Amazon associate delivery count is available for the selected period." }
      : target == null || safe == null
        ? { label: "Target required", tone: "unconfigured", rank: 4, action: "Configure station SPR targets before taking an allocation decision." }
        : evidenceReady === 0
          ? { label: "Observe", tone: "neutral", rank: 2, action: "Select WTD, MTD or a custom range with at least 3 active days before taking station action." }
          : high > 0 && low > 0
          ? { label: "Rebalance routes", tone: "risk", rank: 5, action: `Move Amazon delivery allocation from ${high} above-safe DA${high === 1 ? "" : "s"} toward ${low} below-target DA${low === 1 ? "" : "s"} after checking route compatibility.` }
          : average > safe || highShare >= 0.2
            ? { label: "Split high loads", tone: "risk", rank: 5, action: `${high} DA${high === 1 ? "" : "s"} need route relief; keep daily allocation below the ${fmt(safe, 1)} safe ceiling.` }
            : average < target || lowShare >= 0.4
              ? { label: "Review allocation", tone: "warn", rank: 3, action: `${low} DA${low === 1 ? "" : "s"} are below target; validate route volume and attendance before productivity action.` }
              : { label: "Maintain", tone: "balanced", rank: 1, action: "Station allocation is within range; continue monitoring daily exceptions." };
    return {
      stationCode,
      stationName: locationNameMap.get(stationCode) ?? stationCode,
      associates: stationAssociates.length,
      average,
      high,
      low,
      inRange,
      observing,
      target,
      safe,
      recommendation
    };
  }).sort((left, right) => right.recommendation.rank - left.recommendation.rank || right.high - left.high || left.stationCode.localeCompare(right.stationCode));
  const stationsForAction = stationRecommendations.filter((row) => row.recommendation.rank >= 3).length;
  const associateActions = allAssociates.filter((row) => row.evidenceReady && (row.level === "high" || row.level === "low")).length;
  const recommendationRank: Record<string, number> = { "Target required": 6, "Reduce allocation": 5, "Allocation review": 4, "Monitor peaks": 3, Observe: 2, Maintain: 1 };
  const recommendationAssociates = [...associates];
  if (!searchParams?.sort) recommendationAssociates.sort((left, right) => {
    const rank = (recommendationRank[right.recommendation.label] ?? 0) - (recommendationRank[left.recommendation.label] ?? 0);
    if (rank) return rank;
    const leftGap = left.level === "high" ? left.average - (left.safe ?? left.average) : left.level === "low" ? (left.target ?? left.average) - left.average : 0;
    const rightGap = right.level === "high" ? right.average - (right.safe ?? right.average) : right.level === "low" ? (right.target ?? right.average) - right.average : 0;
    return rightGap - leftGap;
  });
  const shownRecommendationAssociates = recommendationAssociates.slice(0, 200);
  const paramsForSort = new URLSearchParams({ preset, from: start, to: end, band });
  if (selectedStation) paramsForSort.set("station", selectedStation);
  if (searchParams?.stations) paramsForSort.set("stations", searchParams.stations);
  if (activeView === "recommendations") paramsForSort.set("view", "recommendations");
  const sortHref = (key: string) => {
    const next = new URLSearchParams(paramsForSort);
    next.set("sort", key);
    next.set("dir", sort === key && dir === "desc" ? "asc" : "desc");
    return `/ops-pulse/capacity/associates?${next.toString()}`;
  };
  const sortMark = (key: string) => sort === key ? (dir === "asc" ? "↑" : "↓") : "↕";
  const pageHref = (page: number) => {
    const next = new URLSearchParams(paramsForSort);
    next.set("sort", sort);
    next.set("dir", dir);
    next.set("page", String(page));
    return `/ops-pulse/capacity/associates?${next.toString()}`;
  };
  const scopeStations = locations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code, cluster: location.cluster || "", region: location.region || "" }));

  return <AppShell active="Capacity" pageCode="capacity_associates"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Associate Productivity" title="Associate SPR" subtitle="Amazon associate delivery productivity across the selected period." />
    <div className="capacity-tabs-toolbar"><CapacityWorkspaceTabs active="associates" allowed={workspaceTabs} /><CapacityScopeFilter selectedCodes={selectedCodes} stations={scopeStations}/></div>
    <CapacityAssociateViewTabs active={activeView} />
    {locationResult.error || ruleResult.error || associateResult.error ? <div className="message-panel error">{locationResult.error || ruleResult.error || associateResult.error?.message}</div> : null}
    <CapacityAssociateFilters band={band} end={end} preset={preset} start={start} station={selectedStation} stations={searchParams?.stations ?? ""} view={activeView === "recommendations" ? "recommendations" : ""}/>

    {activeView === "productivity" ? <>
      <section className="performance-summary-grid"><article><span>All associates</span><strong>{allAssociates.length}</strong><small>{`${queryLocations.length} stations`}</small></article><article><span>Below target</span><strong>{lowCount}</strong><small>Average below station target SPR</small></article><article><span>Target to safe</span><strong>{targetCount}</strong><small>Within configured range</small></article><article><span>Above safe</span><strong>{highCount}</strong><small>Average above safe SPR</small></article></section>
      <section className="panel"><div className="panel-head"><div><h2>Associate productivity</h2><p className="subtle">SPR = Amazon delivery count ÷ active days. Select an associate for the daily trend.</p></div><div className="capacity-table-pager"><span>{associates.length ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, associates.length)} of ${associates.length}` : "0 associates"}</span>{currentPage > 1 ? <a href={pageHref(currentPage - 1)}>←</a> : <i>←</i>}<b>{currentPage}/{pageCount}</b>{currentPage < pageCount ? <a href={pageHref(currentPage + 1)}>→</a> : <i>→</i>}</div></div><div className="table-wrap"><table className="capacity-daily-table"><thead><tr><th><a href={sortHref("name")}>Associate <small>{sortMark("name")}</small></a></th><th><a href={sortHref("station")}>Station <small>{sortMark("station")}</small></a></th><th><a href={sortHref("days")}>Active days <small>{sortMark("days")}</small></a></th><th><a href={sortHref("delivered")}>Amazon deliveries <small>{sortMark("delivered")}</small></a></th><th><a href={sortHref("average")}>Average SPR <small>{sortMark("average")}</small></a></th><th><a href={sortHref("peak")}>Peak <small>{sortMark("peak")}</small></a></th><th><a href={sortHref("highDays")}>High days <small>{sortMark("highDays")}</small></a></th><th><a href={sortHref("level")}>SPR position <small>{sortMark("level")}</small></a></th></tr></thead><tbody>
        {shownAssociates.map((row) => <tr key={associateIdentityKey(row.stationCode, row.id, row.name)}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/associates/${encodeURIComponent(row.id)}?station=${row.stationCode}&from=${start}&to=${end}&name=${encodeURIComponent(row.name)}`}><strong>{row.name}</strong><small>{row.id}</small></a></td><td><a href={`/ops-pulse/capacity/${row.stationCode}`}>{row.stationCode}</a></td><td>{row.dates}</td><td>{fmt(row.delivered)}</td><td><strong className={row.level === "high" ? "metric-bad-text" : row.level === "low" ? "metric-warn-text" : row.level === "target" ? "metric-good-text" : ""}>{fmt(row.average, 1)}</strong></td><td>{fmt(row.peak)}</td><td>{row.highDays}</td><td><span className={`capacity-decision ${row.level === "high" ? "risk" : row.level === "low" ? "unconfigured" : row.level === "target" ? "balanced" : "no_data"}`}>{row.level === "high" ? `Above ${fmt(row.safe ?? 0, 1)}` : row.level === "low" ? `Below ${fmt(row.target ?? 0, 1)}` : row.level === "target" ? `${fmt(row.target ?? 0, 1)}–${fmt(row.safe ?? 0, 1)}` : "Target required"}</span></td></tr>)}
        {!associates.length ? <tr><td className="empty-cell" colSpan={8}>No associates match these filters.</td></tr> : null}
      </tbody></table></div></section>
    </> : <>
      <section className="performance-summary-grid capacity-decision-summary capacity-spr-recommendation-summary">
        <article><span>Stations for action</span><strong>{stationsForAction}</strong><small>Rebalance or allocation review</small></article>
        <article><span>Associate actions</span><strong>{associateActions}</strong><small>At least 3 active days</small></article>
        <article><span>Above safe</span><strong>{highCount}</strong><small>Route relief candidates</small></article>
        <article><span>Below target</span><strong>{lowCount}</strong><small>Allocation review candidates</small></article>
        <article><span>Observe</span><strong>{limitedEvidenceCount}</strong><small>Less than 3 active days</small></article>
      </section>

      <section className="panel capacity-spr-station-actions">
        <div className="panel-head"><div><h2>Station recommendations</h2><p className="subtle">Manager view of route balance and station-level SPR exceptions.</p></div><span className="status-pill neutral">{stationRecommendations.length} stations</span></div>
        <div className="table-wrap"><table className="capacity-daily-table capacity-spr-recommendation-table"><thead><tr><th>Station</th><th>Average SPR</th><th>Target range</th><th>Associates</th><th>Below</th><th>In range</th><th>Above</th><th>Observe</th><th>Recommendation</th><th>Action</th></tr></thead><tbody>
          {stationRecommendations.map((row) => <tr key={row.stationCode}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/associates?station=${row.stationCode}&preset=${preset}&from=${start}&to=${end}&view=recommendations`}><strong>{row.stationCode}</strong><small>{row.stationName}</small></a></td><td><strong>{row.associates ? fmt(row.average, 1) : "—"}</strong></td><td>{row.target == null || row.safe == null ? "—" : `${fmt(row.target, 1)}–${fmt(row.safe, 1)}`}</td><td>{row.associates}</td><td>{row.low}</td><td>{row.inRange}</td><td>{row.high}</td><td>{row.observing}</td><td><span className={`capacity-decision ${row.recommendation.tone}`}>{row.recommendation.label}</span></td><td><span className="capacity-spr-action">{row.recommendation.action}</span></td></tr>)}
          {!stationRecommendations.length ? <tr><td className="empty-cell" colSpan={10}>No station data is available for this period.</td></tr> : null}
        </tbody></table></div>
      </section>

      <section className="panel capacity-spr-associate-actions">
        <div className="panel-head"><div><h2>Associate recommendations</h2><p className="subtle">Actions use station targets and require at least 3 active days. Highest-priority rows appear first.</p></div><span className="status-pill neutral">{shownRecommendationAssociates.length} of {associates.length}</span></div>
        <div className="table-wrap"><table className="capacity-daily-table capacity-spr-recommendation-table"><thead><tr><th><a href={sortHref("name")}>Associate <small>{sortMark("name")}</small></a></th><th><a href={sortHref("station")}>Station <small>{sortMark("station")}</small></a></th><th><a href={sortHref("days")}>Days <small>{sortMark("days")}</small></a></th><th><a href={sortHref("average")}>Average SPR <small>{sortMark("average")}</small></a></th><th>Target range</th><th><a href={sortHref("highDays")}>High days <small>{sortMark("highDays")}</small></a></th><th>Recommendation</th><th>Action</th></tr></thead><tbody>
          {shownRecommendationAssociates.map((row) => <tr key={associateIdentityKey(row.stationCode, row.id, row.name)}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/associates/${encodeURIComponent(row.id)}?station=${row.stationCode}&from=${start}&to=${end}&name=${encodeURIComponent(row.name)}`}><strong>{row.name}</strong><small>{row.id}</small></a></td><td>{row.stationCode}</td><td>{row.dates}</td><td><strong className={row.level === "high" ? "metric-bad-text" : row.level === "low" ? "metric-warn-text" : row.level === "target" ? "metric-good-text" : ""}>{fmt(row.average, 1)}</strong></td><td>{row.target == null || row.safe == null ? "—" : `${fmt(row.target, 1)}–${fmt(row.safe, 1)}`}</td><td>{row.highDays}</td><td><span className={`capacity-decision ${row.recommendation.tone}`}>{row.recommendation.label}</span></td><td><span className="capacity-spr-action">{row.recommendation.action}</span></td></tr>)}
          {!shownRecommendationAssociates.length ? <tr><td className="empty-cell" colSpan={8}>No associates match these filters.</td></tr> : null}
        </tbody></table></div>
      </section>
    </>}
  </div></AppShell>;
}
