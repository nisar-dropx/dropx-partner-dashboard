'use client';
import { FleetVehicleMeta } from "@/components/fleet-vehicle-meta";

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, RefreshCw, Search, Route, Fuel, Gauge, CircleAlert } from 'lucide-react';
import { dailyFleetCsv, istDate, shiftDay, sortDailyRows, validateReportRange, type DailyFleetReport, type DailyFleetRow, type SortColumn } from '@/lib/fleet/daily-report';
import { FleetMultiSelect } from '@/components/fleet-multi-select';
import { FleetExportButtons } from '@/components/fleet-export-buttons';
import type { FleetControlData } from '@/lib/fleet-control';
import './fleet-daily-report.css';

const numeric = (value: number | null, digits = 1) => value === null ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: digits });
const dateLabel = (date: string | null) => date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : 'Not available';
const statusLabel = { gps_review: 'GPS needs review', ready: 'Distance + fuel', gps_missing: 'Distance unavailable', fuel_missing: 'No fuel recorded', not_applicable: 'Km/L not applicable' };
const columns: Array<{ key: SortColumn; label: string; unit?: string }> = [
  { key: 'date', label: 'Date', unit: 'IST' }, { key: 'vehicle_no', label: 'Vehicle' }, { key: 'station_code', label: 'Station', unit: 'Current allocation' },
  { key: 'km', label: 'Distance', unit: 'km' }, { key: 'litres', label: 'Fuel purchased', unit: 'litres' }, { key: 'fuelAmount', label: 'Fuel spend', unit: '₹' },
  { key: 'mileage', label: 'Est. mileage', unit: 'km/L' }, { key: 'costPerKm', label: 'Fuel cost/km', unit: '₹/km' }
];

export function FleetReports({ fuelReports }: { fuelReports: ReactNode }) {
  const [view, setView] = useState('daily');
  return <div className="fleet-report-workspace">
    <nav className="daily-report-switch" aria-label="Fleet report views">
      <button type="button" aria-pressed={view === 'daily'} onClick={() => setView('daily')}><Route size={16} /> Daily km &amp; mileage</button>
      <button type="button" aria-pressed={view === 'fuel'} onClick={() => setView('fuel')}><Fuel size={16} /> Fuel reports</button>
    </nav>
    {view === 'daily' ? <DailyFleetReportView /> : fuelReports}
  </div>;
}
export function DailyFleetReportView({ focus = 'mileage', stationOptions: masterStations = [] }: { focus?: 'mileage' | 'fuel'; stationOptions?: FleetControlData["stationOptions"] }) {
  const today = istDate();
  const yesterday = shiftDay(today, -1);
  const [range, setRange] = useState({ from: yesterday, to: yesterday });
  const [draft, setDraft] = useState(range);
  const [report, setReport] = useState<DailyFleetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [selectedVehicles, setSelectedVehicles] = useState<string[]>([]);
  const [fuelTypes, setFuelTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [fuelSource, setFuelSource] = useState<'all' | 'bpcl' | 'iocl' | 'paytap'>('all');
  const [sort, setSort] = useState<{ column: SortColumn; direction: 'asc' | 'desc' }>({ column: 'date', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [version, setVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [groupBy, setGroupBy] = useState<'vehicle' | 'station'>(focus === 'fuel' ? 'station' : 'vehicle');
  const syncController = useRef<AbortController | null>(null);

  useEffect(() => () => syncController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch(`/api/fleet/daily-report?${new URLSearchParams(range)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load report.'); return data as DailyFleetReport; })
      .then(data => { setReport(data); setPage(1); })
      .catch(error => { if (!controller.signal.aborted) { setReport(null); setError(error.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, version]);
  useEffect(() => { setPage(1); }, [search, stations, clusters, regions, selectedVehicles, fuelTypes, statuses, sort, pageSize]);

  const vehicles = report?.vehicles ?? [];
  const stationOptions = [...new Set(vehicles.map(v => v.station_code))].sort();
  const fuelOptions = [...new Set(vehicles.map(v => v.fuel_type).filter(Boolean))].sort();
  const stationByCode = useMemo(() => new Map(masterStations.map((station) => [station.code, station])), [masterStations]);
  const filterOption = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/\s+/g, '');
    const sourcePattern = fuelSource === 'bpcl' ? /bpcl/i : fuelSource === 'iocl' ? /ioc|iocl/i : fuelSource === 'paytap' ? /paytm|paytap/i : null;
    return sortDailyRows((report?.rows ?? []).filter(row => (!stations.length || stations.includes(row.station_code)) && (!clusters.length || clusters.includes(stationByCode.get(row.station_code)?.cluster ?? 'Unassigned cluster')) && (!regions.length || regions.includes(stationByCode.get(row.station_code)?.region ?? 'Unassigned region')) && (!selectedVehicles.length || selectedVehicles.includes(row.vehicle_no)) && (!fuelTypes.length || fuelTypes.includes(row.fuel_type)) && (!statuses.length || statuses.includes(row.dataStatus)) && (!sourcePattern || row.fuelBreakdown.some((item) => sourcePattern.test(item.provider))) && (!query || `${row.vehicle_no} ${row.station_code} ${row.model}`.toLowerCase().replace(/\s+/g, '').includes(query))).map((row) => { if (!sourcePattern) return row; const parts = row.fuelBreakdown.filter((item) => sourcePattern.test(item.provider)); const litres = parts.reduce((sum, item) => sum + item.litres, 0); const amount = parts.reduce((sum, item) => sum + item.amount, 0); return { ...row, litres, fuelAmount: amount, fuelTransactions: parts.reduce((sum, item) => sum + item.transactions, 0), fuelSources: parts.map((item) => item.provider), mileage: row.km !== null && litres > 0 ? row.km / litres : null, costPerKm: row.km !== null && row.km > 0 ? amount / row.km : null }; }), sort.column, sort.direction);
  }, [report, search, stations, clusters, regions, selectedVehicles, fuelTypes, statuses, fuelSource, sort, stationByCode]);
  const totals = useMemo(() => rows.reduce((total, row) => {
    total.km += row.km ?? 0; total.litres += row.litres ?? 0; total.amount += row.fuelAmount ?? 0;
    if (row.km === null) total.missing++;
    if (row.mileage !== null) { total.matchedKm += row.km!; total.matchedLitres += row.litres!; }
    return total;
  }, { km: 0, litres: 0, amount: 0, missing: 0, matchedKm: 0, matchedLitres: 0 }), [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const draftError = validateReportRange(draft.from, draft.to, today);
  const datesChanged = draft.from !== range.from || draft.to !== range.to;
  const refreshDisabled = loading || syncing || !rows.length || range.from < shiftDay(today, -31) || (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 >= 7;
  const stationRows = useMemo(() => {
    const values = new Map<string, { station: string; km: number; litres: number; amount: number; transactions: number; vehicles: Set<string>; sources: Set<string> }>();
    rows.forEach((row) => { const item = values.get(row.station_code) ?? { station: row.station_code, km: 0, litres: 0, amount: 0, transactions: 0, vehicles: new Set<string>(), sources: new Set<string>() }; item.km += row.km ?? 0; item.litres += row.litres ?? 0; item.amount += row.fuelAmount ?? 0; item.transactions += row.fuelTransactions; item.vehicles.add(row.vehicle_no); row.fuelSources.forEach((source) => item.sources.add(source)); values.set(row.station_code, item); });
    return [...values.values()].sort((a, b) => focus === 'fuel' ? b.amount - a.amount : b.km - a.km);
  }, [rows, focus]);
  const providerTotals = useMemo(() => {
    const values = new Map<string, { vehicleDays: number }>();
    rows.forEach((row) => row.fuelSources.forEach((source) => { const item = values.get(source) ?? { vehicleDays: 0 }; item.vehicleDays += 1; values.set(source, item); }));
    return [...values.entries()].sort((a, b) => b[1].vehicleDays - a[1].vehicleDays);
  }, [rows]);

  function quickRange(period: string) {
    const selected = period === 'today' ? { from: today, to: today } : period === 'week' ? { from: shiftDay(yesterday, -6), to: yesterday } : period === 'month' ? { from: today.slice(0, 7) + '-01', to: today } : period === 'year' ? { from: today.slice(0, 4) + '-01-01', to: today } : { from: yesterday, to: yesterday };
    setDraft(selected); setRange(selected); setSyncMessage('');
  }

  async function refreshGps() {
    const pairs = rows.map(row => ({ vehicle: row.vehicle_no, date: row.date }));
    const controller = new AbortController(); syncController.current = controller;
    setSyncing(true); setSyncMessage('Connecting to GPS…');
    let done = 0, updated = 0, missing = 0, failed = 0, review = 0;
    try {
      for (let start = 0; start < pairs.length; start += 12) {
        if (controller.signal.aborted) break;
        const response = await fetch('/api/fleet/daily-report/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ pairs: pairs.slice(start, start + 12) }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'GPS refresh failed.');
        for (const item of data.results) { done++; if (item.status === 'updated') updated++; else if (item.status === 'no_data') missing++; else if (item.status === 'needs_review') review++; else failed++; }
        setSyncMessage(`Checked ${done} of ${pairs.length} vehicle-days · ${updated} updated · ${missing} without GPS data · ${review} need GPS review · ${failed} failed`);
      }
    } catch (error) {
      setSyncMessage(controller.signal.aborted ? `Refresh stopped after ${done} vehicle-days. Saved results are retained.` : `${error instanceof Error ? error.message : 'GPS refresh failed.'} ${updated} vehicle-days were saved.`);
    } finally { setSyncing(false); setVersion(value => value + 1); syncController.current = null; }
  }
  const sortColumn = (column: SortColumn) => setSort(current => ({ column, direction: current.column === column && current.direction === 'desc' ? 'asc' : 'desc' }));

  return <div className="daily-fleet-report">
    <header className="daily-report-heading">
      <div><span className="daily-eyebrow">{focus === 'fuel' ? 'FUEL CONTROL' : 'FLEET PERFORMANCE'}</span><h2>{focus === 'fuel' ? 'Fuel log' : 'Distance & mileage'}</h2><p>{focus === 'fuel' ? 'BPCL, IOCL and PayTap fuel activity with vehicle and station views.' : 'Daily kilometres and estimated mileage by vehicle or station.'}</p></div>
      <FleetExportButtons report={{ title: focus === 'fuel' ? 'Fleet fuel report' : 'Fleet distance and mileage report', subtitle: `${range.from} to ${range.to} · active filters applied`, fileName: `fleet-${focus}-${range.from}-${range.to}`, headers: ['Date', 'Vehicle', 'Station', 'Model', 'Fuel type', 'Distance km', 'Fuel litres', 'Fuel amount', 'Mileage km/L', 'Cost/km', 'Transactions', 'Status', 'Providers'], rows: rows.map(row => [row.date, row.vehicle_no, row.station_code, row.model, row.fuel_type, row.km, row.litres, row.fuelAmount, row.mileage, row.costPerKm, row.fuelTransactions, statusLabel[row.dataStatus], row.fuelSources.join(', ')]) }} />
    </header>
    <section className="daily-filter-card" aria-label="Daily fleet report filters">
      <div className="daily-quick-ranges" aria-label="Quick date ranges">{[['yesterday', 'Yesterday'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'MTD'], ['year', 'YTD']].map(([value, label]) => <button key={value} type="button" disabled={syncing} onClick={() => quickRange(value)}>{label}</button>)}<span>All dates in IST</span></div>
      <form className="daily-date-range" onSubmit={event => { event.preventDefault(); if (!draftError) { setRange({ ...draft }); setSyncMessage(''); } }}>
        <label>From date<input type="date" required max={today} value={draft.from} disabled={syncing} onInput={e => setDraft({ ...draft, from: e.currentTarget.value })} /></label>
        <label>To date<input type="date" required max={today} value={draft.to} disabled={syncing} onInput={e => setDraft({ ...draft, to: e.currentTarget.value })} /></label>
        <button className="fleet-btn primary" type="submit" disabled={syncing || Boolean(draftError)}>Apply dates</button>
        <label className="daily-search">Search vehicle, station or model<span><Search size={16} /><input type="search" value={search} placeholder="e.g. KL11BZ1894" disabled={syncing} onChange={e => setSearch(e.target.value)} /></span></label>
      </form>
      {draftError ? <p className="daily-form-error" role="alert">{draftError}</p> : datesChanged ? <p className="daily-filter-note">Apply dates to update the report. Currently showing {dateLabel(range.from)}–{dateLabel(range.to)}.</p> : null}
      <div className="daily-select-filters">
        {masterStations.length ? <FleetMultiSelect allLabel="All regions" disabled={syncing} label="Region" onChange={setRegions} options={filterOption(masterStations.map((station) => station.region))} values={regions} /> : null}
        {masterStations.length ? <FleetMultiSelect allLabel="All clusters" disabled={syncing} label="Cluster" onChange={setClusters} options={filterOption(masterStations.map((station) => station.cluster))} values={clusters} /> : null}
        <FleetMultiSelect allLabel="All permitted stations" disabled={syncing} label="Station" onChange={setStations} options={stationOptions.filter((code) => (!clusters.length || clusters.includes(stationByCode.get(code)?.cluster ?? 'Unassigned cluster')) && (!regions.length || regions.includes(stationByCode.get(code)?.region ?? 'Unassigned region'))).map((value) => ({ value, label: value }))} values={stations} />
        <FleetMultiSelect allLabel="All vehicles" disabled={syncing} label="Vehicle" onChange={setSelectedVehicles} options={vehicles.filter(v => !stations.length || stations.includes(v.station_code)).map(v => ({ value: v.vehicle_no, label: v.vehicle_no, helper: `${v.model || "Model not recorded"} · ${v.station_code || "Station not mapped"}` }))} values={selectedVehicles} />
        <FleetMultiSelect allLabel="All fuel types" disabled={syncing} label="Fuel type" onChange={setFuelTypes} options={filterOption(fuelOptions)} searchable={false} values={fuelTypes} />
        <FleetMultiSelect allLabel="All vehicle-days" disabled={syncing} label="Data availability" onChange={setStatuses} options={Object.entries(statusLabel).map(([value, label]) => ({ value, label }))} values={statuses} />
        <button className="daily-clear" type="button" disabled={syncing} onClick={() => { setSearch(''); setStations([]); setClusters([]); setRegions([]); setSelectedVehicles([]); setFuelTypes([]); setStatuses([]); }}>Clear filters</button>
      </div>
      {focus === 'fuel' ? <div className="daily-source-switch"><span>Fuel source</span>{([['all','All'],['iocl','IOCL'],['bpcl','BPCL'],['paytap','PayTap']] as const).map(([value, text]) => <button className={fuelSource === value ? 'active' : ''} key={value} onClick={() => setFuelSource(value)} type="button">{text}</button>)}</div> : null}<div className="daily-group-switch"><span>Summarise by</span><button className={groupBy === 'vehicle' ? 'active' : ''} onClick={() => setGroupBy('vehicle')} type="button">Vehicle-wise</button><button className={groupBy === 'station' ? 'active' : ''} onClick={() => setGroupBy('station')} type="button">Station-wise</button></div>
    </section>
    {error ? <div className="daily-error" role="alert">{error} <button type="button" onClick={() => setVersion(v => v + 1)}>Retry</button></div> : null}
    {loading ? <div className="daily-loading" role="status">Loading daily distance and fuel records…</div> : report ? <>
      <section className="daily-metrics" aria-label="Filtered report totals">
        <article><Route size={18} /><span>Recorded distance</span><strong>{numeric(rows.length > totals.missing ? totals.km : null)} <small>km</small></strong><p>{rows.length - totals.missing} of {rows.length} vehicle-days</p></article>
        <article><Fuel size={18} /><span>Fuel purchased</span><strong>{numeric(rows.some(row => row.litres !== null) ? totals.litres : null)} <small>L</small></strong><p>₹{numeric(rows.some(row => row.fuelAmount !== null) ? totals.amount : null, 0)} fuel spend</p></article>
        <article><Gauge size={18} /><span>Estimated mileage</span><strong>{numeric(totals.matchedLitres ? totals.matchedKm / totals.matchedLitres : null, 2)} <small>km/L</small></strong><p>Days with both distance and fuel</p></article>
        <article className={totals.missing ? 'daily-metric-warning' : ''}><CircleAlert size={18} /><span>Distance unavailable</span><strong>{totals.missing}</strong><p>Vehicle-days needing GPS data</p></article>
      </section>
      {focus === 'fuel' ? <section className="daily-provider-strip"><article><strong>BPCL</strong><span>{providerTotals.find(([name]) => /bpcl/i.test(name)) ? `${providerTotals.find(([name]) => /bpcl/i.test(name))![1].vehicleDays} vehicle-days` : 'No records'}</span></article><article><strong>IOCL</strong><span>{providerTotals.find(([name]) => /ioc|iocl/i.test(name)) ? `${providerTotals.find(([name]) => /ioc|iocl/i.test(name))![1].vehicleDays} vehicle-days` : 'No records'}</span></article><article><strong>PayTap</strong><span>{providerTotals.find(([name]) => /paytm|paytap/i.test(name)) ? `${providerTotals.find(([name]) => /paytm|paytap/i.test(name))![1].vehicleDays} vehicle-days` : 'No records yet'}</span></article><article><strong>Other / unmapped</strong><span>{providerTotals.filter(([name]) => !/bpcl|ioc|iocl|paytm|paytap/i.test(name)).reduce((sum, [, value]) => sum + value.vehicleDays, 0) || 'None'}</span></article></section> : null}
      <div className="daily-data-note"><strong>How mileage is calculated</strong><p>Estimated km/L = that day’s recorded kilometres ÷ fuel purchased that day. Purchases are not measured fuel consumption; refuelling timing can make this ratio vary. “—” means the data is unavailable or GPS quality needs review. Stopped/cached GPS fixes are filtered automatically. Only a remaining incomplete or inconsistent moving track needs review and is excluded from totals and mileage. Km/L applies to petrol and diesel; CNG/EV consumption is not available in this feed. Today is provisional. Stations reflect current vehicle allocation.</p></div>
      <div className="daily-results-heading"><div><h3>Daily vehicle register</h3><p>{dateLabel(range.from)}–{dateLabel(range.to)} · {new Set(rows.map(r => r.vehicle_no)).size} vehicles · {rows.length} vehicle-days</p></div><div className="daily-refresh-actions"><button type="button" className="fleet-btn ghost" disabled={loading || syncing} onClick={() => setVersion(v => v + 1)}>Reload report</button><button type="button" className="fleet-btn primary" onClick={refreshGps} disabled={refreshDisabled}><RefreshCw size={15} /> Refresh GPS</button>{syncing ? <button type="button" className="fleet-btn ghost" onClick={() => syncController.current?.abort()}>Stop</button> : null}</div></div>
      <p className="daily-freshness">Latest saved distance: {dateLabel(report.latestKmDate)} · Latest fuel date: {dateLabel(report.latestFuelDate)}. GPS refresh covers the filtered vehicles for up to 7 days at a time, within the last 31 days.</p>
      {syncMessage ? <div className="daily-sync-message" role="status" aria-live="polite">{syncMessage}</div> : null}
      {!rows.length ? <div className="daily-loading">No vehicle-days match these filters. Try another date range or clear the filters.</div> : groupBy === 'station' ? <div className="daily-table-scroll" tabIndex={0} aria-label="Station summary"><table className="daily-table"><thead><tr><th>Station</th><th>Vehicles</th><th>Distance km</th><th>Fuel litres</th><th>Fuel spend</th><th>Est. mileage</th><th>Transactions</th><th>Providers</th></tr></thead><tbody>{stationRows.map((row) => <tr key={row.station}><td><details className="daily-station-expand"><summary><strong>{row.station}</strong><small>{stationByCode.get(row.station)?.name ?? 'Current placement'} · expand vehicles</small></summary><div>{[...row.vehicles].sort().map((vehicle) => { const child = rows.filter((item) => item.station_code === row.station && item.vehicle_no === vehicle); const km = child.reduce((sum, item) => sum + (item.km ?? 0), 0); const litres = child.reduce((sum, item) => sum + (item.litres ?? 0), 0); const amount = child.reduce((sum, item) => sum + (item.fuelAmount ?? 0), 0); return <p key={vehicle}><b>{vehicle}</b><FleetVehicleMeta vehicleNo={vehicle} model={child[0]?.model} stationCode={row.station}/><span>{numeric(km)} km · {numeric(litres,2)} L · ₹{numeric(amount,0)} · {numeric(litres ? km/litres : null,2)} km/L</span></p>; })}</div></details></td><td>{row.vehicles.size}</td><td className="daily-number">{numeric(row.km)}</td><td className="daily-number">{numeric(row.litres, 2)}</td><td className="daily-number">₹{numeric(row.amount, 0)}</td><td className="daily-number">{numeric(row.litres ? row.km / row.litres : null, 2)}</td><td className="daily-number">{row.transactions}</td><td>{[...row.sources].join(', ') || '—'}</td></tr>)}</tbody></table></div> : <>
        <div className="daily-table-scroll" tabIndex={0} aria-label="Daily vehicle kilometre and mileage table"><table className="daily-table"><thead><tr>{columns.map(column => <th key={column.key} aria-sort={sort.column === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortColumn(column.key)}>{column.label}<ArrowDownUp size={12} /><small>{column.unit ?? ' '}</small></button></th>)}<th>Data availability</th><th>Details</th></tr></thead><tbody>{pageRows.map(row => <DailyRow key={`${row.vehicle_no}|${row.date}`} row={row} />)}</tbody></table></div>
        <footer className="daily-pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, rows.length)} of {rows.length}</span><label>Rows per page<select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>{[25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label><div><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pages}</span><button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></footer>
      </>}
    </> : null}
  </div>;
}
function DailyRow({ row }: { row: DailyFleetRow }) {
  return <tr>
    <td>{dateLabel(row.date)}{row.provisional ? <small className="daily-provisional">In progress</small> : null}</td>
    <td><strong>{row.vehicle_no}</strong><FleetVehicleMeta vehicleNo={row.vehicle_no} model={row.model} stationCode={row.station_code}/><small>{row.fuel_type}</small></td><td>{row.station_code}</td>
    <td className="daily-number daily-distance">{numeric(row.km)}{row.gpsQuality === 'auto_corrected' ? <small className="daily-gps-filtered">GPS filtered</small> : null}</td><td className="daily-number">{numeric(row.litres, 2)}</td><td className="daily-number">{numeric(row.fuelAmount, 2)}</td><td className="daily-number">{numeric(row.mileage, 2)}</td><td className="daily-number">{numeric(row.costPerKm, 2)}</td>
    <td><span className={`daily-status ${row.dataStatus}`}>{statusLabel[row.dataStatus]}</span></td>
    <td><details><summary>View details</summary><dl><dt>Distance source</dt><dd>{row.distanceSource ?? 'Not recorded'}</dd>{row.dataStatus === 'gps_review' ? <><dt>GPS quality</dt><dd>The moving track is incomplete or inconsistent. Refresh GPS or inspect the trip in Tracking. Raw distance: {numeric(row.rawKm)} km; excluded from totals.</dd></> : null}{row.gpsQuality === 'auto_corrected' ? <><dt>GPS quality</dt><dd>Stopped/cached readings and isolated outliers excluded. GPS-derived distance: {numeric(row.km)} km. Raw connected distance: {numeric(row.rawKm)} km.</dd></> : null}{row.acceptedPoints !== null ? <><dt>Accepted GPS points</dt><dd>{row.acceptedPoints}</dd><dt>Stationary fixes excluded</dt><dd>{row.stationaryPoints}</dd><dt>Invalid/outlier fixes excluded</dt><dd>{row.rejectedPoints}</dd></> : null}<dt>GPS points</dt><dd>{row.pointCount ?? '—'}</dd><dt>Last GPS refresh (IST)</dt><dd>{row.refreshedAt ? new Date(row.refreshedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not refreshed'}</dd><dt>Fuel transactions</dt><dd>{row.fuelTransactions}</dd><dt>Fuel providers</dt><dd>{row.fuelSources.join(', ') || 'Not recorded'}</dd></dl></details></td>
  </tr>;
}
