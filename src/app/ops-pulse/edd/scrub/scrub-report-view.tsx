"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { FleetMultiSelect } from '@/components/fleet-multi-select';
import type { StationScrubActivity } from '@/lib/ops-pulse/edd-worker';
import { formatOpsDateTime } from '@/lib/ops-pulse/date-format';
import { filterScrubRows, scrubCsv, scrubDay, scrubDays, scrubStationRows, scrubStatusLabels, scrubTypes,
  type ScrubCluster, type ScrubSort, type ScrubStationRow, type ScrubSummary } from '@/lib/ops-pulse/scrub-summary';
import s from './scrub-report.module.css';

const labels = {inStation: 'In-station', onRoad: 'On-road'};
const shortTime = (value: string) => new Date(value).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const statuses = Object.entries(scrubStatusLabels).map(([value, label]) => ({value, label}));

export function ScrubReportView({stationNames, clusters}: {stationNames: Record<string, string>; clusters: ScrubCluster[]}) {
  const [data, setData] = useState<StationScrubActivity[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [search, setSearch] = useState('');
  const [stations, setStations] = useState<string[]>([]);
  const [selectedClusters, setClusters] = useState<string[]>([]);
  const [inStation, setInStation] = useState<string[]>([]);
  const [onRoad, setOnRoad] = useState<string[]>([]);
  const [sort, setSort] = useState<ScrubSort>('pending');
  const [openStation, setOpenStation] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/ops-pulse/edd/scrub', {method: refresh ? 'POST' : 'GET', cache: 'no-store', signal});
      const raw = await response.json();
      if (!response.ok || !Array.isArray(raw.stations)) throw new Error(raw.error || 'Could not load scrub activity.');
      if (!signal?.aborted) {setData(raw.stations); setNow(new Date());}
    } catch (err) {if (!signal?.aborted) setError(err instanceof Error ? err.message : 'Could not load scrub activity.');}
    finally {if (!signal?.aborted) setBusy(false);}
  }, []);
  useEffect(() => {const controller = new AbortController(); void load(false, controller.signal); return () => controller.abort();}, [load]);
  useEffect(() => {const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer);}, []);

  const rows = useMemo(() => scrubStationRows(data ?? [], stationNames, now), [data, stationNames, now]);
  const visible = useMemo(() => filterScrubRows(rows, clusters, {stations, clusters: selectedClusters, inStation, onRoad, search, sort}), [rows, clusters, stations, selectedClusters, inStation, onRoad, search, sort]);
  const stationOptions = Object.entries(stationNames).map(([value, name]) => ({value, label: value, helper: name}));
  const clusterOptions = clusters.map(({value, label}) => ({value, label}));
  const done = visible.filter(row => row.inStation.status === 'done' && row.onRoad.status === 'done').length;
  const pending = visible.filter(row => scrubTypes.some(type => ['pending', 'none'].includes(row[type].status))).length;
  const unknown = visible.filter(row => scrubTypes.some(type => ['stale', 'unavailable'].includes(row[type].status))).length;
  function reset() {setStations([]); setClusters([]); setInStation([]); setOnRoad([]); setSearch(''); setSort('pending');}
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([scrubCsv(visible)], {type: 'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = `scrub-stations-${scrubDay(now)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={s.workspace} aria-label="Station scrub overview">
    <div className={s.filters}>
      <FleetMultiSelect label="Station" allLabel="All stations" values={stations} options={stationOptions} onChange={setStations} alwaysSearch />
      <FleetMultiSelect label="Cluster / AOM" allLabel="All clusters / AOMs" values={selectedClusters} options={clusterOptions} onChange={setClusters} alwaysSearch />
      <FleetMultiSelect label="In-station status" allLabel="All statuses" values={inStation} options={statuses} onChange={setInStation} />
      <FleetMultiSelect label="On-road status" allLabel="All statuses" values={onRoad} options={statuses} onChange={setOnRoad} />
      <label className={s.sort}>Sort<select value={sort} onChange={event => setSort(event.target.value as ScrubSort)}>
        <option value="pending">Most pending first</option><option value="station">Station A–Z</option>
        <option value="inStation">In-station pending</option><option value="onRoad">On-road pending</option><option value="latest">Latest scrub first</option>
      </select></label>
      <button className={s.plain} type="button" onClick={reset}>Reset</button>
    </div>
    <div className={s.toolbar}>
      <input aria-label="Search stations" type="search" placeholder="Search station…" value={search} onChange={event => setSearch(event.target.value)} />
      {data ? <div className={s.counts} aria-live="polite"><strong>{visible.length}/{rows.length} stations</strong><span className={s.done}>{done} both done</span><span className={s.pending}>{pending} pending</span>{unknown ? <span>{unknown} need data</span> : null}</div> : <span role="status">{busy ? 'Loading scrub activity…' : 'Scrub activity unavailable'}</span>}
      <div className={s.actions}><button type="button" onClick={exportCsv} disabled={!data || !visible.length}><Download size={14} /> CSV</button><button type="button" onClick={() => void load(true)} disabled={busy}><RefreshCw size={14} /> {busy ? 'Loading…' : 'Fetch now'}</button></div>
    </div>
    {error ? <p className={s.error} role="alert">{error} {data ? 'Showing the last loaded results.' : ''} <button type="button" onClick={() => void load(false)} disabled={busy}>Retry</button></p> : null}
    {data ? <><div className={s.scroll}><table className={s.table}>
      <thead><tr><th>Station</th><th>In-station scrub</th><th>On-road scrub</th><th>Fetched · IST</th></tr></thead>
      <tbody>{visible.map(row => {
        const expanded = openStation === row.stationCode;
        return <Fragment key={row.stationCode}><tr>
          <th scope="row"><button className={s.station} aria-expanded={expanded} aria-controls={`scrub-${row.stationCode}`} onClick={() => setOpenStation(expanded ? null : row.stationCode)}>{row.stationCode}<span>{row.name}</span></button></th>
          {scrubTypes.map(type => <td key={type}><ScrubCell value={row[type]} label={`${row.stationCode} ${labels[type]}`} expanded={expanded} controls={`scrub-${row.stationCode}`} onClick={() => setOpenStation(expanded ? null : row.stationCode)} /></td>)}
          <td className={s.fetched}>{row.fetchedAt ? shortTime(row.fetchedAt) : 'Not fetched'}</td>
        </tr>{expanded ? <tr id={`scrub-${row.stationCode}`}><td colSpan={4} className={s.expansion}><ScrubHistory row={row} now={now} onClose={() => setOpenStation(null)} /></td></tr> : null}</Fragment>;
      })}{!visible.length ? <tr><td colSpan={4} className={s.empty}>No stations match. <button type="button" onClick={reset}>Reset filters</button></td></tr> : null}</tbody>
    </table></div><p className={s.legend}>Pending = days since last scrub · 7+ = none in the available 7-day log · click a status for times and operators · IST</p></> : null}
  </section>;
}

function ScrubCell({value, label, expanded, controls, onClick}: {value: ScrubSummary; label: string; expanded: boolean; controls: string; onClick: () => void}) {
  return <button className={s.cellButton} type="button" aria-label={`${label}: ${value.label}. View history`} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
    <span className={`${s.badge} ${s[value.status]}`}>{value.label}</span><span className={s.cellMeta}>{value.lastAt ? shortTime(value.lastAt) : '—'} <span>· {value.daysScrubbed}/7 days</span></span>
  </button>;
}

function ScrubHistory({row, now, onClose}: {row: ScrubStationRow; now: Date; onClose: () => void}) {
  return <div className={s.history}>
    <div className={s.historyHead}><strong>{row.stationCode} · Last 7 days</strong><button type="button" onClick={onClose} aria-label={`Close ${row.stationCode} history`}>Close</button></div>
    {scrubTypes.map(type => row[type].error || ['stale', 'unavailable'].includes(row[type].status) ? <p key={type} className={s.historyNotice}>{labels[type]}: {row[type].error || 'Refresh to confirm today’s status.'}{row.fetchedAt ? ` Last fetched ${formatOpsDateTime(row.fetchedAt)}.` : ''}</p> : null)}
    <table className={s.historyTable}><thead><tr><th>Day · IST</th><th>In-station · time / operator</th><th>On-road · time / operator</th></tr></thead><tbody>
      {scrubDays(now).map(day => <tr key={day}><th scope="row">{day === scrubDay(now) ? 'Today' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata'})}</th>
        {scrubTypes.map(type => {
          const value = row[type]; const items = value.invocations.filter(item => scrubDay(item.at) === day);
          const observed = row.fetchedAt && day <= scrubDay(row.fetchedAt) && !value.error;
          return <td key={type}>{items.length ? items.map((item, index) => <div key={`${item.at}-${index}`} className={s.invocation}><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit'})}</time> · {item.operator ?? 'Unknown operator'}</div>) : <span className={observed ? s.pending : s.stale}>{observed ? 'Not scrubbed' : 'Not confirmed'}</span>}</td>;
        })}</tr>)}
    </tbody></table>
  </div>;
}
