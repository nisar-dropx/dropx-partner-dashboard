'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, Download, RefreshCw, Search, Route, Fuel, Gauge, CircleAlert } from 'lucide-react';
import { dailyFleetCsv, istDate, shiftDay, sortDailyRows, validateReportRange, type DailyFleetReport, type DailyFleetRow, type SortColumn } from '@/lib/fleet/daily-report';
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
export function DailyFleetReportView() {
  const today = istDate();
  const yesterday = shiftDay(today, -1);
  const [range, setRange] = useState({ from: yesterday, to: yesterday });
  const [draft, setDraft] = useState(range);
  const [report, setReport] = useState<DailyFleetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [station, setStation] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [fuelType, setFuelType] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<{ column: SortColumn; direction: 'asc' | 'desc' }>({ column: 'date', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [version, setVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
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
  useEffect(() => { setPage(1); }, [search, station, vehicle, fuelType, status, sort, pageSize]);

  const vehicles = report?.vehicles ?? [];
  const stationOptions = [...new Set(vehicles.map(v => v.station_code))].sort();
  const fuelOptions = [...new Set(vehicles.map(v => v.fuel_type).filter(Boolean))].sort();
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/\s+/g, '');
    return sortDailyRows((report?.rows ?? []).filter(row => (!station || row.station_code === station) && (!vehicle || row.vehicle_no === vehicle) && (!fuelType || row.fuel_type === fuelType) && (!status || row.dataStatus === status) && (!query || `${row.vehicle_no} ${row.station_code} ${row.model}`.toLowerCase().replace(/\s+/g, '').includes(query))), sort.column, sort.direction);
  }, [report, search, station, vehicle, fuelType, status, sort]);
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

  function quickRange(period: string) {
    const selected = period === 'today' ? { from: today, to: today } : period === 'week' ? { from: shiftDay(yesterday, -6), to: yesterday } : period === 'month' ? { from: today.slice(0, 7) + '-01', to: today } : { from: yesterday, to: yesterday };
    setDraft(selected); setRange(selected); setSyncMessage('');
  }
  function download() {
    const href = URL.createObjectURL(new Blob([dailyFleetCsv(rows)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = href; link.download = `fleet-daily-km-mileage-${range.from}-${range.to}.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
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
      <div><span className="daily-eyebrow">FLEET PERFORMANCE</span><h2>Daily vehicle km &amp; mileage</h2><p>Distance travelled, fuel purchases and estimated mileage in one view.</p></div>
      <button className="fleet-btn ghost" type="button" disabled={loading || syncing || !rows.length} onClick={download}><Download size={16} /> Download CSV</button>
    </header>
    <section className="daily-filter-card" aria-label="Daily fleet report filters">
      <div className="daily-quick-ranges" aria-label="Quick date ranges">{[['yesterday', 'Yesterday'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']].map(([value, label]) => <button key={value} type="button" disabled={syncing} onClick={() => quickRange(value)}>{label}</button>)}<span>All dates in IST</span></div>
      <form className="daily-date-range" onSubmit={event => { event.preventDefault(); if (!draftError) { setRange({ ...draft }); setSyncMessage(''); } }}>
        <label>From date<input type="date" required max={today} value={draft.from} disabled={syncing} onInput={e => setDraft({ ...draft, from: e.currentTarget.value })} /></label>
        <label>To date<input type="date" required max={today} value={draft.to} disabled={syncing} onInput={e => setDraft({ ...draft, to: e.currentTarget.value })} /></label>
        <button className="fleet-btn primary" type="submit" disabled={syncing || Boolean(draftError)}>Apply dates</button>
        <label className="daily-search">Search vehicle, station or model<span><Search size={16} /><input type="search" value={search} placeholder="e.g. KL11BZ1894" disabled={syncing} onChange={e => setSearch(e.target.value)} /></span></label>
      </form>
      {draftError ? <p className="daily-form-error" role="alert">{draftError}</p> : datesChanged ? <p className="daily-filter-note">Apply dates to update the report. Currently showing {dateLabel(range.from)}–{dateLabel(range.to)}.</p> : null}
      <div className="daily-select-filters">
        <label>Station<select disabled={syncing} value={station} onChange={e => { setStation(e.target.value); setVehicle(''); }}><option value="">All permitted stations</option>{stationOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Vehicle<select disabled={syncing} value={vehicle} onChange={e => setVehicle(e.target.value)}><option value="">All vehicles</option>{vehicles.filter(v => !station || v.station_code === station).map(v => <option key={v.vehicle_no} value={v.vehicle_no}>{v.vehicle_no}</option>)}</select></label>
        <label>Fuel type<select disabled={syncing} value={fuelType} onChange={e => setFuelType(e.target.value)}><option value="">All fuel types</option>{fuelOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Data availability<select disabled={syncing} value={status} onChange={e => setStatus(e.target.value)}><option value="">All vehicle-days</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="daily-clear" type="button" disabled={syncing} onClick={() => { setSearch(''); setStation(''); setVehicle(''); setFuelType(''); setStatus(''); }}>Clear filters</button>
      </div>
    </section>
    {error ? <div className="daily-error" role="alert">{error} <button type="button" onClick={() => setVersion(v => v + 1)}>Retry</button></div> : null}
    {loading ? <div className="daily-loading" role="status">Loading daily distance and fuel records…</div> : report ? <>
      <section className="daily-metrics" aria-label="Filtered report totals">
        <article><Route size={18} /><span>Recorded distance</span><strong>{numeric(rows.length > totals.missing ? totals.km : null)} <small>km</small></strong><p>{rows.length - totals.missing} of {rows.length} vehicle-days</p></article>
        <article><Fuel size={18} /><span>Fuel purchased</span><strong>{numeric(rows.some(row => row.litres !== null) ? totals.litres : null)} <small>L</small></strong><p>₹{numeric(rows.some(row => row.fuelAmount !== null) ? totals.amount : null, 0)} fuel spend</p></article>
        <article><Gauge size={18} /><span>Estimated mileage</span><strong>{numeric(totals.matchedLitres ? totals.matchedKm / totals.matchedLitres : null, 2)} <small>km/L</small></strong><p>Days with both distance and fuel</p></article>
        <article className={totals.missing ? 'daily-metric-warning' : ''}><CircleAlert size={18} /><span>Distance unavailable</span><strong>{totals.missing}</strong><p>Vehicle-days needing GPS data</p></article>
      </section>
      <div className="daily-data-note"><strong>How mileage is calculated</strong><p>Estimated km/L = that day’s recorded kilometres ÷ fuel purchased that day. Purchases are not measured fuel consumption; refuelling timing can make this ratio vary. “—” means the data is unavailable or GPS quality needs review. Suspect GPS distances are excluded from totals and mileage. Km/L applies to petrol and diesel; CNG/EV consumption is not available in this feed. Today is provisional. Stations reflect current vehicle allocation.</p></div>
      <div className="daily-results-heading"><div><h3>Daily vehicle register</h3><p>{dateLabel(range.from)}–{dateLabel(range.to)} · {new Set(rows.map(r => r.vehicle_no)).size} vehicles · {rows.length} vehicle-days</p></div><div className="daily-refresh-actions"><button type="button" className="fleet-btn ghost" disabled={loading || syncing} onClick={() => setVersion(v => v + 1)}>Reload report</button><button type="button" className="fleet-btn primary" onClick={refreshGps} disabled={refreshDisabled}><RefreshCw size={15} /> Refresh GPS</button>{syncing ? <button type="button" className="fleet-btn ghost" onClick={() => syncController.current?.abort()}>Stop</button> : null}</div></div>
      <p className="daily-freshness">Latest saved distance: {dateLabel(report.latestKmDate)} · Latest fuel date: {dateLabel(report.latestFuelDate)}. GPS refresh covers the filtered vehicles for up to 7 days at a time, within the last 31 days.</p>
      {syncMessage ? <div className="daily-sync-message" role="status" aria-live="polite">{syncMessage}</div> : null}
      {!rows.length ? <div className="daily-loading">No vehicle-days match these filters. Try another date range or clear the filters.</div> : <>
        <div className="daily-table-scroll" tabIndex={0} aria-label="Daily vehicle kilometre and mileage table"><table className="daily-table"><thead><tr>{columns.map(column => <th key={column.key} aria-sort={sort.column === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortColumn(column.key)}>{column.label}<ArrowDownUp size={12} /><small>{column.unit ?? ' '}</small></button></th>)}<th>Data availability</th><th>Details</th></tr></thead><tbody>{pageRows.map(row => <DailyRow key={`${row.vehicle_no}|${row.date}`} row={row} />)}</tbody></table></div>
        <footer className="daily-pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, rows.length)} of {rows.length}</span><label>Rows per page<select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>{[25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label><div><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pages}</span><button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></footer>
      </>}
    </> : null}
  </div>;
}
function DailyRow({ row }: { row: DailyFleetRow }) {
  return <tr>
    <td>{dateLabel(row.date)}{row.provisional ? <small className="daily-provisional">In progress</small> : null}</td>
    <td><strong>{row.vehicle_no}</strong><small>{row.model} · {row.fuel_type}</small></td><td>{row.station_code}</td>
    <td className="daily-number daily-distance">{numeric(row.km)}</td><td className="daily-number">{numeric(row.litres, 2)}</td><td className="daily-number">{numeric(row.fuelAmount, 2)}</td><td className="daily-number">{numeric(row.mileage, 2)}</td><td className="daily-number">{numeric(row.costPerKm, 2)}</td>
    <td><span className={`daily-status ${row.dataStatus}`}>{statusLabel[row.dataStatus]}</span></td>
    <td><details><summary>View details</summary><dl><dt>Distance source</dt><dd>{row.distanceSource ?? 'Not recorded'}</dd>{row.dataStatus === 'gps_review' ? <><dt>GPS quality</dt><dd>Implausible jumps detected. Verify the trip in Tracking. Raw distance: {numeric(row.rawKm)} km; excluded from totals.</dd></> : null}<dt>GPS points</dt><dd>{row.pointCount ?? '—'}</dd><dt>Last GPS refresh (IST)</dt><dd>{row.refreshedAt ? new Date(row.refreshedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not refreshed'}</dd><dt>Fuel transactions</dt><dd>{row.fuelTransactions}</dd><dt>Fuel providers</dt><dd>{row.fuelSources.join(', ') || 'Not recorded'}</dd></dl></details></td>
  </tr>;
}
