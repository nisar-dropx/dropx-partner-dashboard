'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChartNoAxesCombined } from 'lucide-react';
import { shiftDay, type PaymentVolume } from '@/lib/payment-volume';
import styles from './payment-volume-context.module.css';

const number = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString('en-IN');
const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const timestamp = (date: string | null) => date ? new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ' IST' : 'Unavailable';

export function PaymentVolumeContext({ locationId, date, initialData, initialError }: {
  locationId?: string; date: string; initialData?: PaymentVolume | null; initialError?: string;
}) {
  const [data, setData] = useState<PaymentVolume | null>(initialData ?? null);
  const [error, setError] = useState(initialError ?? '');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [historyDays, setHistoryDays] = useState(14);
  useEffect(() => {
    if (initialData !== undefined) { setData(initialData); setError(initialError ?? ''); return; }
    const controller = new AbortController();
    setData(null); setError(''); setOpen(false);
    if (!locationId || !date) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/payments/volume-context?${new URLSearchParams({ location: locationId, date })}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load volume history.');
        if (!controller.signal.aborted) setData(body as PaymentVolume);
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load volume history.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, locationId, initialData, initialError, retry]);
  const requested = data?.days.find(day => day.date === date);
  const previous = data?.days.find(day => day.date === shiftDay(date, -1));
  const difference = data?.difference == null ? '—' : `${data.difference > 0 ? '+' : ''}${data.difference.toFixed(1)}%`;
  const history = data?.days.slice(-historyDays).reverse() ?? [];
  const max = Math.max(1, ...history.flatMap(day => [day.inbound ?? 0, day.delivered ?? 0]));
  const stale = data?.snapshotAt ? data.snapshotAt.slice(0, 10) < shiftDay(date, -1) : true;
  return <section className={styles.context} aria-label="Station volume and vehicle evidence">
    <div className={styles.top}><strong><ChartNoAxesCombined size={16} aria-hidden="true" /> Volume check {data ? <span>· {data.station}</span> : null}</strong><span className={styles.tag}>Station evidence</span></div>
    {loading ? <p role="status">Loading station volume…</p> : error ? <p role="alert">{error} {initialData === undefined ? <button type="button" className="button secondary compact" onClick={() => setRetry(retry + 1)}>Retry</button> : <span>Reload this page to retry.</span>}</p> : !data ? <p>Select a station and deployment date to see the volume check.</p> : <>
      <div className={styles.summary}>
        <div><span>{date === data.today ? "Today's inbound" : `${dayLabel(date)} inbound`}</span><b>{number(requested?.inbound)}</b></div>
        <div><span>{dayLabel(shiftDay(date, -1))} delivered</span><b>{number(previous?.delivered)}</b></div>
        <div><span>Usual {new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })} inbound</span><b>{number(data.baseline)}</b></div>
        <div><span>Indicative change</span><b>{difference}</b></div>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={styles.expand}>{open ? 'Hide history' : 'View history'}<ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button>
      </div>
      <p className={styles.caution}>{requested?.inboundUnverified ? 'Serving station unverified · inbound and spike withheld' : requested?.inbound == null ? 'No inbound import for this date' : stale ? 'Old snapshot · spike unverified' : 'Expected arrivals · approx.'} {data.baseline == null ? `· BAU incomplete (${data.baselineDays}/4)` : null}</p>
      {(data.groupStations?.length??0)>1?<p><strong>{data.groupStations?.join(' + ')}</strong> · combined parent volume. {data.breakup?.map(b=>`${b.station} ${number(b.inbound)}`).join(' · ')}{data.unallocated?` · Station split unavailable for ${number(data.unallocated)} packages`:''}</p>:null}
      <div className={styles.quickRow}>
        <span>{requested?.inbound == null ? 'Package size split unavailable' : <>Approx. <b>Small / bike {number(data.classified - (data.bulky ?? 0))}</b> · <b>Volumetric / van {number(data.bulky)}</b> · Unclassified {number(data.packages - data.classified)}</>}</span>
        <button type="button" className={styles.expand} aria-expanded={fleetOpen} onClick={() => setFleetOpen(!fleetOpen)}>Vehicles at station · {data.fleetError ? 'Unavailable' : `${data.vehicles.filter(v => v.operational).length} operational today`} <ChevronDown size={14} aria-hidden="true" /></button>
      </div>
      {fleetOpen ? <div className={styles.details}>
        <div className={styles.detailHead}><strong>Station vehicles · {dayLabel(data.today)}</strong><span className={styles.tag}>Current Fleet records</span></div>
        {data.fleetError ? <p role="alert">{data.fleetError}</p> : <>
          <p><strong>{data.vehicles.filter(v => v.operational).length} operational</strong> · {data.vehicles.filter(v => v.deployed && !v.operational).length} deployed but unavailable · {data.vehicles.filter(v => !v.deployed).length} not deployed.</p>
          {date === data.today && data.vehicles.length ? <p>{data.vehicles.filter(v => v.operational).length} recorded operational + 1 van in this request = <strong>{data.vehicles.filter(v => v.operational).length + 1} planned if approved</strong>. Other ad hoc requests are not included.</p> : <p>This is today's availability, not a reconstructed fleet position for {dayLabel(date)}.</p>}
          {data.vehicles.length ? <div className={styles.vehicleList}>{data.vehicles.map(vehicle => <div key={vehicle.id} className={styles.vehicle}><div><strong>{vehicle.number}</strong><span>{vehicle.model} · {vehicle.source}</span><small>{vehicle.partner} · Location: {vehicle.location}</small></div><span className={vehicle.operational ? styles.available : styles.unavailable}>{vehicle.deployed ? vehicle.status : 'Not deployed'}</span></div>)}</div> : <p>No vehicles are registered to this station. This does not confirm that no vehicles are physically available.</p>}
        </>}
      </div> : null}
      {open ? <div className={styles.details}>
        <div className={styles.detailHead}><div><strong>Inbound vs delivered</strong><p>{(data.groupStations?.length??0)>1?`${data.groupStations?.join(" + ")} · unique packages across the parent group`:data.requireDestination ? `Verified ${data.station} destinations only · unverified history withheld` : `${data.station} arriving-load volume`}</p></div><label>History<select aria-label="Volume history period" value={historyDays} onChange={e => setHistoryDays(Number(e.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={28}>28 days</option></select></label></div>
        {date !== data.today ? <p><strong>Today, {dayLabel(data.today)}:</strong> {number(data.todayInbound)} expected inbound shipments. Request comparison stays on {dayLabel(date)}.</p> : null}
        <div className={styles.legend}><span><i className={styles.inbound} />Expected inbound</span><span><i className={styles.delivered} />Delivered</span></div>
        <div className={styles.tableWrap}><table><thead><tr><th>Date</th><th>Inbound</th><th>Delivered</th><th>Trend</th></tr></thead><tbody>{history.map(day => <tr key={day.date}><th>{dayLabel(day.date)}{day.date === date ? <small>Request day</small> : null}</th><td>{number(day.inbound)}{day.inboundUnverified ? <small>Routing unverified</small> : null}</td><td>{number(day.delivered)}</td><td><div className={styles.bars} aria-label={`${dayLabel(day.date)}: ${number(day.inbound)} inbound, ${number(day.delivered)} delivered`}><i className={styles.inbound} style={{ width: `${(day.inbound ?? 0) / max * 100}%` }} /><i className={styles.delivered} style={{ width: `${(day.delivered ?? 0) / max * 100}%` }} /></div></td></tr>)}</tbody></table></div>
        <p>— means missing inbound data or unverified serving-station routing. Deliveries may include earlier-day packages; inbound minus delivered is not backlog or a delivery-success rate.</p>
        <div className={styles.foot}><div><strong>Approximate vehicle suitability</strong><p>{data.bulky == null ? 'Unavailable' : `${number(data.bulky)} van-needed · ${data.classified ? (data.bulky / data.classified * 100).toFixed(1) : "0"}% of classified packages`} · classified {number(data.classified)}/{number(data.packages)} using the shipment-size master.</p>{data.sizeRule ? <p>Small: within {data.sizeRule.maxLengthCm} × {data.sizeRule.maxWidthCm} × {data.sizeRule.maxHeightCm} cm, {data.sizeRule.maxWeightKg} kg actual and {data.sizeRule.maxDimensionalWeightKg} kg volumetric (L × W × H ÷ {data.sizeRule.dimensionalDivisor}). Exceeding any limit is van-needed. Confirm load, packaging and route suitability.</p> : <p>No valid shipment-size rule is available.</p>}</div><div><strong>Source freshness</strong><p>Latest station inbound snapshot: {timestamp(data.latestInboundSnapshot ?? null)}<br />Latest request-day snapshot: {timestamp(data.snapshotAt)}<br />Report checked: {timestamp(data.refreshedAt)}</p></div></div>
        {requested?.inboundUnverified ? <p className={styles.caution}>The original destination is missing for {number(requested.inboundUnverified)} packages recorded under this station. Re-import the source with destination station codes to verify inbound, package sizes and the spike.</p> : null}
        <p>BAU = mean inbound from the previous 4 matching weekdays. Re-imports can change historical records. Current evidence is informational; it does not automatically approve or reject the request.</p>
      </div> : null}
    </>}
  </section>;
}
