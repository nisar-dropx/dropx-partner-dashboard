import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { loadCodLocations, locationLabel, locationModelName } from "@/lib/ops-pulse/cod";
import {
  operatingModeLabel,
  resolveOperatingContext
} from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { OpsStationManpowerBoard } from "@/components/ops-station-manpower-board";

type SearchParams = { date?: string; from?: string; to?: string; shift?: string; view?: string; location?: string };
type ShipmentFact = {
  station_code: string;
  shipment_type: string | null;
  total_activity: number | string | null;
  total_delivery: number | string | null;
  work_date: string;
};
type CpsFact = {
  station_code: string;
  work_date: string;
  total_delivery: number | string | null;
  overall_cps: number | string | null;
  target_cps: number | string | null;
  target_gap: number | string | null;
  target_impact: number | string | null;
};
type PerformanceFact = {
  source_type: "daily_edsp_metrics" | "edsp_sls_scorecard";
  report_year: number | null;
  report_week: number | null;
  report_date: string | null;
  station_code: string | null;
  row_label: string | null;
  raw_text: string | null;
  values_json: unknown;
  created_at: string;
};

export const dynamic = "force-dynamic";

function todayIst() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone: "Asia/Kolkata", year: "numeric"
  }).format(new Date());
}

function selectedDate(value?: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? String(value) : todayIst();
}

function selectedRange(fromValue: string | undefined, toValue: string | undefined, fallback: string) {
  const to = selectedDate(toValue || fallback);
  const defaultFrom = `${to.slice(0, 7)}-01`;
  const from = selectedDate(fromValue || defaultFrom);
  return from <= to ? { from, to } : { from: to, to: from };
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function amazonWeek(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay();
  const start = addDays(value, -day);
  const end = addDays(start, 6);
  const yearStart = `${value.slice(0, 4)}-01-01`;
  const firstWeekStart = addDays(yearStart, -new Date(`${yearStart}T00:00:00Z`).getUTCDay());
  const week = Math.floor((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${firstWeekStart}T00:00:00Z`)) / 604800000) + 1;
  return { end, start, week: Math.max(1, week) };
}

function previousMonth(value: string) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const start = date.toISOString().slice(0, 10);
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { start, end: endDate.toISOString().slice(0, 10) };
}

function weightedCps(rows: CpsFact[]) {
  const deliveries = rows.reduce((total, row) => total + Number(row.total_delivery ?? 0), 0);
  if (!deliveries) return 0;
  return rows.reduce((total, row) => total + Number(row.overall_cps ?? 0) * Number(row.total_delivery ?? 0), 0) / deliveries;
}

function weightedTarget(rows: CpsFact[]) {
  const deliveries = rows.reduce((total, row) => total + Number(row.total_delivery ?? 0), 0);
  if (!deliveries) return 0;
  return rows.reduce((total, row) => total + Number(row.target_cps ?? 0) * Number(row.total_delivery ?? 0), 0) / deliveries;
}

function ranges(date: string) {
  const [year, month] = date.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    monthEnd: `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
    monthStart: `${year}-${String(month).padStart(2, "0")}-01`,
    yearStart: `${year}-01-01`
  };
}

function sum(rows: ShipmentFact[], from: string, to: string, field: "total_delivery" | "total_activity" = "total_delivery") {
  return rows.reduce((total, row) => row.work_date >= from && row.work_date <= to ? total + Number(row[field] ?? 0) : total, 0);
}

function count(value: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

function modelAccent(mode: string) {
  if (mode === "amazon_now") return "now";
  if (mode === "flipkart_odh_mdh") return "flipkart";
  return "amazon";
}

async function shipmentFacts(companyId: string, stationCodes: string[], from: string, to: string) {
  if (!supabaseAdmin) return { error: "Supabase connection is unavailable.", rows: [] as ShipmentFact[] };
  const { data, error } = await supabaseAdmin
    .from("cps_shipment_daily")
    .select("station_code,shipment_type,total_activity,total_delivery,work_date")
    .eq("company_id", companyId)
    .in("station_code", stationCodes)
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date");
  return { error: error?.message ?? null, rows: (data ?? []) as ShipmentFact[] };
}

export default async function OpsPulsePage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("ops_pulse", "access");
  const companyId = requireCompanyId(authorization);
  const locationsResult = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess
  );
  const context = resolveOperatingContext(locationsResult.locations);
  const selectedLocations = context.selectedLocations;
  const date = selectedDate(searchParams?.date);
  const dashboardView = searchParams?.view === "manpower" ? "manpower" : "operations";
  if (dashboardView === "manpower") {
    const requestedLocation = String(searchParams?.location ?? "");
    const requestedStation = locationsResult.locations.find((location) => location.id === requestedLocation);
    const selectedManpowerLocation = requestedStation ?? selectedLocations[0] ?? locationsResult.locations[0] ?? null;
    const manpowerLocations = selectedManpowerLocation ? [selectedManpowerLocation] : [];
    let manpower: Awaited<ReturnType<typeof loadOpsStationManpower>> = { asOf: date, people: [] };
    let manpowerError = locationsResult.error;
    if (!manpowerError) {
      try {
        manpower = await loadOpsStationManpower(companyId, manpowerLocations, date);
      } catch (error) {
        manpowerError = error instanceof Error ? error.message : "Station manpower could not be loaded.";
      }
    }
    return <AppShell active="Dashboard" pageCode="ops_pulse">
      <div className="ops-command-center">
        <PageHead eyebrow="Live workforce · scope controlled" title="Shift Attendance" subtitle="See each authorised office, station or store roster, reporting times and attendance exceptions." action={<span className="ops-live-badge"><i /> LIVE PEOPLE</span>} />
        <nav className="ops-dashboard-view-switch" aria-label="OpsPulse dashboard views">
          <Link href="/ops-pulse">Operations view</Link>
          <Link className="active" href="/ops-pulse?view=manpower">Shift attendance</Link>
        </nav>
        {manpowerError ? <section className="panel message-panel error"><div className="panel-body"><strong>Data connection issue</strong><p className="subtle">{manpowerError}</p></div></section> : null}
        <form className="ops-station-manpower-filter" action="/ops-pulse" method="get">
          <input name="view" type="hidden" value="manpower" />
          <label>Date<input name="date" type="date" defaultValue={date} max={todayIst()} /></label>
          <label>Office, station or store<select name="location" defaultValue={selectedManpowerLocation?.id ?? ""}>
            {locationsResult.locations.map((location) => <option key={location.id} value={location.id}>{location.station_code} · {location.station_name || location.city || location.station_code}</option>)}
          </select></label>
          <button type="submit">Apply location</button>
        </form>
        <OpsStationManpowerBoard asOf={manpower.asOf} locations={manpowerLocations} people={manpower.people} />
      </div>
    </AppShell>;
  }
  const range = selectedRange(searchParams?.from, searchParams?.to, date);
  const { monthEnd, monthStart, yearStart } = ranges(date);
  const priorMonth = previousMonth(range.to);
  const queryStart = [yearStart, priorMonth.start, range.from].sort()[0];
  const stationCodes = selectedLocations.map((location) => location.station_code);
  const locationIds = selectedLocations.map((location) => location.id);
  const factsResult = selectedLocations.length
    ? await shipmentFacts(companyId, stationCodes, queryStart, monthEnd)
    : { error: null, rows: [] as ShipmentFact[] };
  const facts = factsResult.rows;
  const attendanceResult = isNaN(Date.parse(`${date}T00:00:00Z`)) || !context.location || !supabaseAdmin
    ? { data: [], error: null }
    : await supabaseAdmin.from("attendance_daily")
      .select("enrolment_id,worker_name,employee_code,in_time,out_time,punch_count,work_minutes,status,remark")
      .eq("company_id", companyId)
      .in("location_id", selectedLocations.map((location) => location.id))
      .eq("punch_date", date)
      .order("in_time", { ascending: true });
  const [cpsResult, scorecardResult, executivesResult] = !supabaseAdmin || !selectedLocations.length
    ? [
      { data: [] as CpsFact[], error: null },
      { data: [] as PerformanceFact[], error: null },
      { data: [] as Array<{ id: string; onboarding_status: string | null; is_active: boolean }>, error: null }
    ]
    : await Promise.all([
      supabaseAdmin.from("cps_station_daily")
        .select("station_code,work_date,total_delivery,overall_cps,target_cps,target_gap,target_impact")
        .eq("company_id", companyId).in("station_code", stationCodes)
        .gte("work_date", queryStart).lte("work_date", range.to),
      supabaseAdmin.from("report_metric_facts")
        .select("source_type,report_year,report_week,report_date,station_code,row_label,raw_text,values_json,created_at")
        .eq("company_id", companyId).in("station_code", stationCodes)
        .in("source_type", ["daily_edsp_metrics", "edsp_sls_scorecard"])
        .order("created_at", { ascending: false })
        .limit(5000),
      supabaseAdmin.from("workforce")
        .select("id,onboarding_status,is_active")
        .in("location_id", locationIds).eq("is_active", true)
    ]);
  const attendance = attendanceResult.data ?? [];
  const dayVolume = sum(facts, date, date);
  const rangeVolume = sum(facts, range.from, range.to);
  const dayActivity = sum(facts, date, date, "total_activity");
  const monthVolume = sum(facts, monthStart, monthEnd);
  const mtdVolume = sum(facts, monthStart, date);
  const ytdVolume = sum(facts, yearStart, date);
  const activeDays = new Set(facts.filter((row) => Number(row.total_delivery ?? 0) > 0).map((row) => row.work_date)).size;
  const average = activeDays ? Math.round(ytdVolume / activeDays) : 0;
  const daily = [...new Map(facts.filter((row) => row.work_date >= monthStart && row.work_date <= date).map((row) => [
    row.work_date,
    sum(facts, row.work_date, row.work_date)
  ])).entries()];
  const maxDaily = Math.max(...daily.map(([, value]) => value), 1);
  const accent = modelAccent(context.mode);
  const isNow = context.mode === "amazon_now";
  const selectedShift = searchParams?.shift || "current";
  const shiftStartHour = selectedShift === "night" ? 21 : 9;
  const reported = attendance.length;
  const singlePunch = attendance.filter((row) => Number(row.punch_count ?? 0) < 2).length;
  const late = attendance.filter((row) => {
    if (!row.in_time) return false;
    const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(row.in_time));
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute > shiftStartHour * 60 + 15;
  }).length;
  const completedShift = attendance.filter((row) => row.out_time && Number(row.work_minutes ?? 0) >= 600).length;
  const cpsRows = (cpsResult.data ?? []) as CpsFact[];
  const rangeCpsRows = cpsRows.filter((row) => row.work_date >= range.from && row.work_date <= range.to);
  const mtdCpsRows = cpsRows.filter((row) => row.work_date >= monthStart && row.work_date <= range.to);
  const previousCpsRows = cpsRows.filter((row) => row.work_date >= priorMonth.start && row.work_date <= priorMonth.end);
  const rangeCps = weightedCps(rangeCpsRows);
  const mtdCps = weightedCps(mtdCpsRows);
  const targetCps = weightedTarget(mtdCpsRows);
  const previousCps = weightedCps(previousCpsRows);
  const cpsDeficit = Math.max(0, mtdCps - targetCps);
  const cpsImpact = mtdCpsRows.reduce((total, row) => total + Number(row.target_impact ?? 0), 0);
  const performanceFacts = (scorecardResult.data ?? []) as PerformanceFact[];
  const latestSlsWeek = Math.max(...performanceFacts.filter((row) => row.source_type === "edsp_sls_scorecard").map((row) => Number(row.report_week ?? 0)), 0);
  const weeklyScorecards = performanceFacts.filter((row) => row.source_type === "edsp_sls_scorecard" && Number(row.report_week) === latestSlsWeek);
  const dailyScorecards = performanceFacts.filter((row) => row.source_type === "daily_edsp_metrics");
  const slsScores = weeklyScorecards
    .map((row) => Array.isArray(row.values_json) ? Number(row.values_json[1]) : 0)
    .filter((value) => value > 0 && value <= 1);
  const averageSlsScore = slsScores.length ? slsScores.reduce((total, value) => total + value, 0) / slsScores.length : 0;
  const week = amazonWeek(range.to);
  const executives = executivesResult.data ?? [];
  const onboardingPending = executives.filter((row) => row.onboarding_status !== "active").length;
  const onboardingActive = executives.filter((row) => row.onboarding_status === "active").length;
  const stationComparison = selectedLocations.map((location) => {
    const stationCpsRows = mtdCpsRows.filter((row) => row.station_code === location.station_code);
    const stationShipmentRows = facts.filter((row) => row.station_code === location.station_code && row.work_date >= range.from && row.work_date <= range.to);
    const stationDaily = dailyScorecards.find((row) => row.station_code === location.station_code);
    const stationSls = weeklyScorecards.find((row) => row.station_code === location.station_code);
    const dailyValues = Array.isArray(stationDaily?.values_json) ? stationDaily.values_json.map(Number) : [];
    const measuredDaily = [5, 6, 7, 8, 11, 12, 13, 14, 15, 20].filter((index) => Number(dailyValues[index] ?? 0) > 0);
    const dailyHealthy = measuredDaily.filter((index) => {
      const value = Number(dailyValues[index] ?? 0);
      const targets: Record<number, number> = { 5: .965, 6: .942, 7: .965, 8: .942, 11: .94, 12: .89, 13: .9, 14: .85, 15: .987 };
      return index === 20 ? value >= .9 : value >= (targets[index] ?? 0);
    }).length;
    const cps = weightedCps(stationCpsRows);
    const target = weightedTarget(stationCpsRows);
    const gap = cps - target;
    const sls = Array.isArray(stationSls?.values_json) ? Number(stationSls.values_json[1] ?? 0) : 0;
    const volume = stationShipmentRows.reduce((total, row) => total + Number(row.total_delivery ?? 0), 0);
    const issues = (gap > 0 ? 1 : 0) + (sls > 0 && sls < .8 ? 1 : 0) + (measuredDaily.length && dailyHealthy < measuredDaily.length ? 1 : 0);
    return { code: location.station_code, name: location.station_name || location.city || location.station_code, volume, cps, target, gap, sls, dailyHealthy, dailyMeasured: measuredDaily.length, issues };
  }).sort((a, b) => b.issues - a.issues || b.gap - a.gap);
  const stationsAboveTarget = stationComparison.filter((row) => row.gap > 0).length;
  const stationsWithSlsRisk = stationComparison.filter((row) => row.sls > 0 && row.sls < .8).length;
  const latestPerformanceImport = performanceFacts.map((row) => row.created_at).sort().at(-1) ?? null;
  const scopeLabel = selectedLocations.length > 1
    ? `${selectedLocations.length} selected locations`
    : context.location ? locationLabel(context.location) : "No mapped location";

  return (
    <AppShell active="Dashboard" pageCode="ops_pulse">
      <div className={`ops-command-center ${accent}`}>
        <PageHead
          eyebrow={`${operatingModeLabel(context.mode)} · ${scopeLabel}`}
          title={isNow ? "Live Shift Command Center" : "Operations Command Center"}
          subtitle={isNow
            ? "Store, attendance, shift readiness, hourly output and live exceptions in one operational view."
            : "A focused view of shipment movement, CPS readiness, cash controls and operational exceptions."}
          action={<span className="ops-live-badge"><i /> {isNow ? "LIVE MODE" : "OPERATIONAL"}</span>}
        />

        <nav className="ops-dashboard-view-switch" aria-label="OpsPulse dashboard views">
          <Link className="active" href="/ops-pulse">Operations view</Link>
          <Link href="/ops-pulse?view=manpower">Shift attendance</Link>
        </nav>

        {locationsResult.error || factsResult.error || attendanceResult.error || cpsResult.error || scorecardResult.error || executivesResult.error ? (
          <section className="panel message-panel error"><div className="panel-body"><strong>Data connection issue</strong><p className="subtle">{locationsResult.error ?? factsResult.error ?? attendanceResult.error?.message ?? cpsResult.error?.message ?? scorecardResult.error?.message ?? executivesResult.error?.message}</p></div></section>
        ) : null}

        <section className="ops-control-strip">
          <div className="ops-context-summary">
            <span>Selected workspace</span>
            <strong>{operatingModeLabel(context.mode)}</strong>
            <small>{selectedLocations.length > 1 ? `${selectedLocations.length} permitted locations combined` : context.location ? `${context.location.station_code} · ${context.location.station_name} · ${locationModelName(context.location)}` : "No permitted mapped station"}</small>
          </div>
          <form action="/ops-pulse" className="ops-date-controls">
            <label>From<input name="from" type="date" defaultValue={range.from} /></label>
            <label>To<input name="to" type="date" defaultValue={range.to} /></label>
            {isNow ? <label>Shift<select name="shift" defaultValue={selectedShift}><option value="current">Current shift</option><option value="day">09:00–21:00</option><option value="night">21:00–09:00</option></select></label> : null}
            <button type="submit">Refresh view</button>
          </form>
        </section>

        <section className="ops-module">
          <header><div><span>VOLUME</span><h2>Shipment movement</h2></div><Link href="/cps?view=shipments">View shipment data →</Link></header>
          <div className="ops-kpi-grid">
            <article><div className="ops-kpi-icon">R</div><span>Selected range</span><strong>{count(rangeVolume)}</strong><small>{range.from} to {range.to}</small></article>
            <article><div className="ops-kpi-icon">D</div><span>Latest day</span><strong>{count(dayVolume)}</strong><small>{date}</small></article>
            <article><div className="ops-kpi-icon">M</div><span>MTD volume</span><strong>{count(mtdVolume)}</strong><small>Month total {count(monthVolume)}</small></article>
            <article><div className="ops-kpi-icon">Y</div><span>YTD volume</span><strong>{count(ytdVolume)}</strong><small>{activeDays} active days</small></article>
          </div>
        </section>

        <section className="ops-dashboard-modules">
          <article className="ops-module">
            <header><div><span>STATION PERFORMANCE</span><h2>Amazon EDSP performance</h2></div><Link href="/ops-pulse/performance">Open workspace →</Link></header>
            <div className="ops-stat-list">
              <div><small>Daily EDSP Metrics</small><strong>{dailyScorecards.length ? `${new Set(dailyScorecards.map((row) => row.station_code).filter(Boolean)).size} stations` : "Awaiting import"}</strong><span>{dailyScorecards.length ? "Latest uploaded daily performance report" : "No daily EDSP Metrics rows found"}</span></div>
              <div><small>Amazon SLS Scorecard</small><strong>{weeklyScorecards.length ? `Week ${latestSlsWeek} · ${(averageSlsScore * 100).toFixed(1)}%` : "Awaiting import"}</strong><span>{weeklyScorecards.length ? `${slsScores.length} station scores loaded` : "No weekly SLS rows found"}</span></div>
              <div><small>Amazon week {week.week}</small><strong>{week.start}</strong><span>Sunday–Saturday · ends {week.end}</span></div>
            </div>
          </article>

          <article className="ops-module">
            <header><div><span>CPS CONTROL</span><h2>Cost per shipment</h2></div><Link href="/cps">Open CPS →</Link></header>
            <div className="ops-stat-list">
              <div><small>Range CPS</small><strong>₹ {rangeCps.toFixed(2)}</strong><span>{range.from} to {range.to}</span></div>
              <div><small>MTD / Target</small><strong>₹ {mtdCps.toFixed(2)} / ₹ {targetCps.toFixed(2)}</strong><span>{cpsDeficit ? `₹ ${cpsDeficit.toFixed(2)} above target` : "On or below target"}</span></div>
              <div><small>Previous month</small><strong>₹ {previousCps.toFixed(2)}</strong><span>Deficit impact ₹ {count(cpsImpact)}</span></div>
            </div>
          </article>

          <article className="ops-module">
            <header><div><span>WORK FORCE REGISTER</span><h2>Contractor onboarding</h2></div><Link href="/work-force-register">Open register →</Link></header>
            <div className="ops-onboarding-figure">
              <div><strong>{onboardingPending}</strong><span>Pending</span></div>
              <div><strong>{onboardingActive}</strong><span>Completed</span></div>
              <div><strong>{executives.length}</strong><span>Active DAs</span></div>
            </div>
            <small className="ops-module-note">Live from field executive onboarding status for the selected locations.</small>
          </article>
        </section>

        <section className="ops-module station-command-matrix">
          <header><div><span>SCOPE-AWARE REVIEW</span><h2>{selectedLocations.length === 1 ? "Station operating scorecard" : `${selectedLocations.length}-station control matrix`}</h2></div><Link href="/ops-pulse/performance">Open detailed performance →</Link></header>
          <div className="station-matrix-summary">
            <span><strong>{stationsAboveTarget}</strong>CPS above target</span>
            <span><strong>{stationsWithSlsRisk}</strong>SLS below 80%</span>
            <span><strong>{stationComparison.filter((row) => row.issues === 0).length}</strong>No flagged variance</span>
            <span><strong>{formatDashboardDate(latestPerformanceImport, "—")}</strong>Performance freshness</span>
          </div>
          <div className="performance-matrix-wrap">
            <table className="station-overview-table">
              <thead><tr><th>Station</th><th>Range volume</th><th>MTD CPS</th><th>Target</th><th>Gap / deficit</th><th>Latest SLS</th><th>Daily metrics met</th><th>Attention</th></tr></thead>
              <tbody>{stationComparison.map((row) => <tr key={row.code}>
                <td><strong>{row.code}</strong><small>{row.name}</small></td>
                <td>{count(row.volume)}</td>
                <td>₹ {row.cps.toFixed(2)}</td>
                <td>₹ {row.target.toFixed(2)}</td>
                <td className={row.gap > 0 ? "metric-bad" : "metric-good"}>{row.target ? `${row.gap > 0 ? "+" : ""}₹ ${row.gap.toFixed(2)}` : "—"}</td>
                <td className={row.sls && row.sls < .8 ? "metric-bad" : row.sls ? "metric-good" : ""}>{row.sls ? `${(row.sls * 100).toFixed(1)}%` : "—"}</td>
                <td>{row.dailyMeasured ? `${row.dailyHealthy}/${row.dailyMeasured}` : "—"}</td>
                <td><span className={`station-attention ${row.issues ? "risk" : "clear"}`}>{row.issues ? `${row.issues} flag${row.issues === 1 ? "" : "s"}` : "Clear"}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="ops-visual-grid">
          <article className="ops-visual-card wide">
            <header><div><span>VOLUME TREND</span><h2>Daily throughput</h2></div><strong>{count(mtdVolume)} MTD</strong></header>
            <div className="ops-bar-chart" aria-label="Daily volume chart">
              {daily.length ? daily.map(([workDate, value]) => (
                <div className="ops-bar-column" key={workDate} title={`${formatDashboardDate(workDate)}: ${count(value)}`}>
                  <span style={{ height: `${Math.max(4, Math.round((value / maxDaily) * 100))}%` }} />
                  <small>{workDate.slice(-2)}</small>
                </div>
              )) : <div className="ops-empty-visual">No shipment imports are available for this location and month.</div>}
            </div>
          </article>

          <article className="ops-visual-card">
            <header><div><span>WORKSPACE HEALTH</span><h2>Today’s readiness</h2></div></header>
            <div className="ops-health-list">
              <div><i className={facts.length ? "good" : "warn"} /><span>Shipment data</span><strong>{facts.length ? "Available" : "Pending"}</strong></div>
              <div><i className="good" /><span>Station mapping</span><strong>Ready</strong></div>
              <div><i className={dayActivity ? "good" : "warn"} /><span>Daily activity</span><strong>{dayActivity ? "Active" : "Not received"}</strong></div>
              <div><i className="neutral" /><span>Exceptions</span><strong>Review queue</strong></div>
            </div>
          </article>
        </section>

        {isNow ? (
          <section className="ops-visual-grid">
            <article className="ops-visual-card wide">
              <header><div><span>SHIFT CONTROL</span><h2>Store reporting timeline</h2></div><Link href="/ops-pulse/daily-submission">Open attendance</Link></header>
              <div className="ops-kpi-grid compact">
                <article><div className="ops-kpi-icon">R</div><span>Reported</span><strong>{reported}</strong><small>Real attendance rows</small></article>
                <article className={late ? "attention" : "healthy"}><div className="ops-kpi-icon">L</div><span>Late</span><strong>{late}</strong><small>After shift + 15 min</small></article>
                <article className={singlePunch ? "attention" : "healthy"}><div className="ops-kpi-icon">1</div><span>Single punch</span><strong>{singlePunch}</strong><small>Needs correction</small></article>
                <article><div className="ops-kpi-icon">✓</div><span>Completed shift</span><strong>{completedShift}</strong><small>10+ working hours</small></article>
              </div>
              <div className="now-attendance-list">
                {attendance.slice(0, 12).map((row) => <div key={row.enrolment_id}><strong>{row.worker_name || row.employee_code || row.enrolment_id}</strong><span>{row.in_time ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(row.in_time)) : "No in-punch"}</span><b>{Number(row.work_minutes ?? 0)} min</b></div>)}
                {!attendance.length ? <div className="ops-empty-visual">No attendance records received for this store and date.</div> : null}
              </div>
            </article>
            <article className="ops-visual-card">
              <header><div><span>ACTION CENTER</span><h2>Live attention</h2></div></header>
              <div className="ops-health-list">
                <div><i className={reported ? "good" : "warn"} /><span>Attendance feed</span><strong>{reported ? `${reported} reported` : "No data"}</strong></div>
                <div><i className={late ? "warn" : "good"} /><span>Late reporting</span><strong>{late}</strong></div>
                <div><i className={singlePunch ? "warn" : "good"} /><span>Punch exceptions</span><strong>{singlePunch}</strong></div>
                <div><i className={dayActivity ? "good" : "warn"} /><span>Shipment activity</span><strong>{count(dayActivity)}</strong></div>
              </div>
            </article>
          </section>
        ) : (
          <section className="ops-action-grid">
            <Link href="/ops-pulse/daily-submission"><span>01</span><div><strong>Daily operations</strong><small>Review station submission and imported activity</small></div><b>→</b></Link>
            <Link href={context.mode === "flipkart_odh_mdh" ? "/ops-pulse/cod/submission?client=flipkart" : "/ops-pulse/cod/executive-reconciliation?client=amazon"}><span>02</span><div><strong>COD control</strong><small>Capture, reconcile and close cash liability</small></div><b>→</b></Link>
            <Link href="/cps"><span>03</span><div><strong>CPS performance</strong><small>Inspect shipments, associates and cost performance</small></div><b>→</b></Link>
          </section>
        )}
      </div>
    </AppShell>
  );
}
