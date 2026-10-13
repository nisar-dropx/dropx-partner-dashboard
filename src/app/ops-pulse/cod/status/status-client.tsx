'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { codStatusCategory, codStatusToday, codStatusChecks, codToneLabels, classifyRemittance, matchesCodFilters, compareCodRows, type CodSort, type CodTone, type CodStatusLocation, type CodStatusSnapshot } from '@/lib/ops-pulse/cod-status';
import { reconciliationView, collectionDay, validCollectionDate } from '@/lib/ops-pulse/cod-reconciliation';
import { pickupExpectation } from '@/lib/ops-pulse/cod-pickup';
import styles from './status.module.css';
type Part = 'reconciliation' | 'prepareDeposit' | 'remittances';
type Row = { snapshot?: CodStatusSnapshot; loading?: boolean; error?: string };
const amount = (n: number) => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 }).format(n);
const dateLabel = (value:string) => new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric'}).format(new Date(value+'T00:00:00+05:30'));
const time = (value: string | number | null | undefined) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true }).format(new Date(value)) : 'Not available';

export function CodStatusClient({ locations }: { locations: CodStatusLocation[] }) {
  const [rows,setRows] = useState<Record<string,Row>>({});
  const [search,setSearch] = useState(''), [model,setModel] = useState(''), [manager,setManager] = useState(''), [region,setRegion] = useState(''), [filter,setFilter] = useState('');
  const [parts,setParts] = useState({reconciliation:'',prepareDeposit:'',remittances:''});
  const [sort,setSort] = useState<CodSort>('station'), [direction,setDirection] = useState<'asc'|'desc'>('asc');
  const [expanded,setExpanded] = useState<{id:string;part:Part} | null>(null);
  const [now,setNow] = useState(() => new Date());
  const [dateMode,setDateMode] = useState('all'), [customDate,setCustomDate] = useState(()=>codStatusToday());
  const today=codStatusToday(now);
  const collectionDate=dateMode==='all'?'':dateMode==='today'?today:dateMode==='yesterday'?new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10):dateMode==='undated'?'undated':customDate;
  const cashView=(l:CodStatusLocation)=>reconciliationView(rows[l.id]?.snapshot?.reconciliation.data,collectionDate,l.reconDueTime || null,now);
  const busy = useRef(new Set<string>());
  const alive = useRef(true);
  const [refreshing,setRefreshing] = useState(false);
  const refresh = useCallback(async (id: string, fresh = false) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setRows(prev => ({...prev,[id]:{...prev[id],loading:true,error:undefined}}));
    try {
      const response = await fetch(`/api/ops-pulse/cod/status?location=${encodeURIComponent(id)}${fresh?'&refresh=1':''}`, { cache:'no-store',signal:AbortSignal.timeout(115000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Check unavailable. Please retry.');
      if (alive.current) setRows(prev => ({...prev,[id]:{snapshot:data,loading:false}}));
    } catch (error) {
      if (alive.current) setRows(prev => ({...prev,[id]:{...prev[id],loading:false,error:error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Check timed out. Please retry.'}}));
    } finally { busy.current.delete(id); }
  },[]);
  const refreshMany = useCallback(async (ids: string[], fresh: boolean) => {
    setRefreshing(true);
    const queue = [...ids];
    await Promise.all(Array.from({length:3}, async () => {
      while (queue.length && alive.current) { const id = queue.shift(); if (id) await refresh(id,fresh); }
    }));
    if (alive.current) { setRefreshing(false); setNow(new Date()); }
  },[refresh]);
  useEffect(() => {
    alive.current = true;
    void refreshMany(locations.map(l=>l.id),false);
    const timer = setInterval(()=>setNow(new Date()),60000);
    return () => { alive.current=false; clearInterval(timer); };
  },[locations,refreshMany]);
  const checks = (l:CodStatusLocation) => codStatusChecks(rows[l.id]?.snapshot,l.pickup || null,now,!!rows[l.id]?.error,collectionDate,l.reconDueTime || null);
  const status = (l:CodStatusLocation) => codStatusCategory(rows[l.id]?.snapshot,now,l.pickup || null,!!rows[l.id]?.error,collectionDate,l.reconDueTime || null);
  const selected = locations.filter(l=>matchesCodFilters(l,checks(l),status(l),{search,model,manager,region}));
  const snapshots = Object.fromEntries(Object.entries(rows).map(([id,row])=>[id,row.snapshot]));
  const visible = selected.filter(l=>matchesCodFilters(l,checks(l),status(l),{overall:filter,...parts})).sort((a,b)=>compareCodRows(a,b,snapshots,sort,direction,now,collectionDate));
  const totals:Record<CodTone,number> = {attention:0,active:0,waiting:0,clear:0,unavailable:0,unchecked:0};
  selected.forEach(l=>totals[status(l)]++);
  const options = useMemo(()=>({models:[...new Set(locations.map(l=>l.model).filter(Boolean))].sort(),managers:[...new Set(locations.flatMap(l=>l.managers || [l.manager]).filter(Boolean))].sort(),regions:[...new Set(locations.map(l=>l.region).filter(Boolean))].sort()}),[locations]);
  const reset = () => {setDateMode('all');setSearch('');setModel('');setManager('');setRegion('');setFilter('');setParts({reconciliation:'',prepareDeposit:'',remittances:''});setSort('station');setDirection('asc');};
  const statusOptions = <><option value="">All statuses</option>{Object.entries(codToneLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</>;
  const toneClass = (tone:CodTone) => tone==='clear'?styles.good:tone==='attention'?styles.bad:tone==='waiting'?styles.warn:tone==='active'?styles.active:styles.neutral;
  const toggle = (id: string,part: Part) => setExpanded(prev=>prev?.id===id && prev.part===part ? null : {id,part});
  function cell(l: CodStatusLocation,part: Part) {
    const row=rows[l.id], s=row?.snapshot, component=s?.[part];
    const result=checks(l)[part];
    if (!component?.data) return <div className={styles.unknown}>{row?.loading ? 'Checking…' : result.label}{!row?.loading && <button className={styles.retry} onClick={()=>refresh(l.id,true)}>Retry station</button>}</div>;
    let headline=result.label, detail=result.reason;
    if (part==='reconciliation') {
      const r=cashView(l);
      headline=r.pendingCount ? `${r.pendingCount} DA · ${amount(r.amount)}` : result.label;
      const dated=r.dateTotals.map(([day])=>day);
      detail=collectionDate && collectionDate!=='undated' ? `Collected ${dateLabel(collectionDate)} · ${result.label}` : dated.length ? `Collected ${dateLabel(dated[0])}${dated.length>1 ? ` – ${dateLabel(dated[dated.length-1])}` : ''} · ${result.label}` : result.label;
    } else if (part==='prepareDeposit') {
      const p=s!.prepareDeposit.data!;
      if ([p.expectedAmount,p.actualAmount,p.variance].some(v=>Math.abs(v)>=0.01)) {
        headline=`${amount(p.expectedAmount)} to prepare`;
        detail=`Actual cash ${amount(p.actualAmount)}${Math.abs(p.variance)>=0.01?' · Difference '+amount(p.variance):''}`;
      }
    } else {
      const m=s!.remittances.data!;
      detail=m.latestSubmitted ? `${m.latestSubmitted.code || 'No code'} · Updated ${time(m.latestSubmitted.updatedAt)}` : result.reason;
    }
    return <button className={`${styles.cell} ${toneClass(result.tone)}`} onClick={()=>toggle(l.id,part)} aria-expanded={expanded?.id===l.id && expanded.part===part} aria-label={`${l.code} ${part==='reconciliation'?'DA reconciliation':part==='prepareDeposit'?'prepare deposit':'COD deposition'} details`}>
      <strong>{headline} <span aria-hidden>›</span></strong><small>{detail}</small>{part==='reconciliation' && <><small>{result.reason}</small>{collectionDate && cashView(l).priorAmount>0 && <small>All dates: {amount(cashView(l).priorAmount)} earlier-day cash still outstanding</small>}</>}{part==='remittances' && s?.remittances.data?.latestSubmitted && <small>{result.reason}</small>}{part!=='reconciliation' && result.tone==='unavailable' && <small>{result.reason}</small>}
    </button>;
  }
  function details(s: CodStatusSnapshot, part: Part, location:CodStatusLocation) {
    if(part==='reconciliation') {
      const r=cashView(location);
      return <><h3>Cash with associates · {collectionDate==='undated'?'date unverified':collectionDate?dateLabel(collectionDate):'all collection dates'}</h3>
        <p>Current outstanding cash, grouped by the original COD collection date. Checked {time(s.reconciliation.checkedAt)} IST. This is not a historical end-of-day balance.</p>
        <div className={styles.cashDates}><span className={styles.active}>Collected today <b>{amount(r.todayAmount)}</b></span><span className={styles.bad}>Earlier days <b>{amount(r.priorAmount)}</b></span>{r.unknownDrivers>0 && <span className={styles.neutral}>Date unverified <b>{amount(r.unknownAmount)}</b> · {r.unknownDrivers} DA</span>}</div>
        <p>DA closing time: <b>{location.reconDueTime ? `${location.reconDueTime} IST` : 'Not configured in COD Pickup Master'}</b>. Collection time and transaction update are supplied by Amazon; neither is the OpsPulse refresh time.</p>
        {!r.drivers.length ? <p>{r.check.reason}</p> : <div className={styles.drivers}>{r.drivers.map(d=><details key={d.id}><summary><span><b>{d.name}</b><small>{d.id}</small></span><strong>{amount(d.pendingAmount)}</strong></summary>{d.packages.length ? <div className={styles.scroll}><table><thead><tr><th>Tracking ID (TID)</th><th>COD collected · IST</th><th>Last COD transaction · IST</th><th>Age / status</th><th>Pending amount</th></tr></thead><tbody>{d.packages.map((p,i)=>{
          const day=collectionDay(p.collectedAt,now);
          const age=day?Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(day+'T00:00:00Z'))/86400000):null;
          const overdue=age!==null && (age>0 || !!location.reconDueTime && now.getTime()>=Date.parse(`${today}T${location.reconDueTime}:00+05:30`));
          return <tr key={`${p.trackingId}-${i}`}><td>{p.trackingId}<small>{p.paymentMethod}</small></td><td>{time(p.collectedAt)}</td><td>{time(p.transactionAt)}</td><td><span className={age===null?styles.neutral:overdue?styles.bad:styles.active}>{age===null?'Date unverified':age>0?`${age} day${age===1?'':'s'} · overdue`:overdue?'Today · overdue':'Today'}</span></td><td>{amount(p.amount)}</td></tr>;
        })}</tbody></table></div>:<p>No shipment-level dates were returned by the portal for this balance.</p>}</details>)}</div>}
      </>;
    }
    if(part==='prepareDeposit') {
      const p=s.prepareDeposit.data;
      return <><h3>Cash waiting for prepare deposit</h3><p>Matches Amazon’s Prepare Deposit overview. Checked {time(s.prepareDeposit.checkedAt)} IST.</p>{p && <div className={styles.amounts}><div><small>Expected cash</small><strong>{amount(p.expectedAmount)}</strong></div><div><small>Actual cash</small><strong>{amount(p.actualAmount)}</strong></div><div><small>Short / excess</small><strong>{amount(p.variance)}</strong></div></div>}<p>Preparing a deposit and submitting a remittance are separate steps. Complete the transaction in Amazon.</p></>;
    }
    const m=s.remittances.data;
    return <><h3>COD remittance details</h3><p>Portal window: {time(s.remittanceWindow.startTime)} – {time(s.remittanceWindow.endTime)} IST. Records outside this window are not checked here. “Submitted” is Amazon’s status; it does not confirm bank settlement.</p>{!m?.complete && <p className={styles.warning}>The source check is incomplete. Do not treat the absence of an open remittance as clearance.</p>}<div className={styles.scroll}><table><thead><tr><th>Remittance</th><th>Portal status</th><th>Pickup assessment</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Created</th><th>Last updated · IST</th><th>Submitted by</th></tr></thead><tbody>{m?.rows.map(r=>{const assessment=['CREATED','PENDING_SUBMISSION'].includes(r.status.toUpperCase())?classifyRemittance(r,m.latestSubmitted,location.pickup || null,now):null;return <tr key={r.id}><td><strong>{r.code||'Code not issued'}</strong></td><td><span className={['CREATED','PENDING_SUBMISSION'].includes(r.status)?styles.warn:styles.neutral}>{r.status}</span></td><td>{assessment?<span className={`${styles.assessment} ${toneClass(assessment.tone)}`} title={assessment.reason}>{assessment.label}</span>:'—'}</td><td>{amount(r.expectedAmount)}</td><td>{amount(r.actualAmount)}</td><td>{amount(r.variance)}</td><td>{time(r.createdAt)}</td><td>{time(r.updatedAt)}</td><td>{r.submittedBy||'—'}</td></tr>;})}</tbody></table>{!m?.rows.length && <p>No remittances returned in this portal window.</p>}</div></>;
  }
  return <div className={styles.root}>
    <div className={styles.toolbar}><div><strong>Today · {now.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'})}</strong><small>{locations.length} authorized locations · All times IST</small></div><button className={styles.refresh} disabled={refreshing} onClick={()=>refreshMany(selected.map(l=>l.id),true)}>{refreshing?'Checking stations…':'Refresh selected stations'}</button></div>
    <section className={styles.dateBar} aria-label="COD collection date">
      <div><strong>COD collection date</strong><small>Filter cash still with associates by the date it was collected.</small></div>
      <label className={styles.dateSelect}>Show<select aria-label="COD collection date filter" value={dateMode} onChange={e=>setDateMode(e.target.value)}><option value="all">All outstanding dates</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="custom">Choose date</option><option value="undated">Date unverified</option></select></label>
      {dateMode==='custom' && <label>Collection date<input type="date" aria-label="Collection date" value={customDate} max={today} onChange={e=>{if(validCollectionDate(e.target.value,today))setCustomDate(e.target.value);}}/></label>}
      <small>Prepare Deposit and Remittances remain live balances; the portal does not attribute those totals to a collection date.</small>
    </section>
    <div className={styles.filters}>
      <label>Find station<input placeholder="Station code or name" value={search} onChange={e=>setSearch(e.target.value)} /></label>
      <label>Region<select value={region} onChange={e=>setRegion(e.target.value)}><option value="">All regions</option>{options.regions.map(v=><option key={v}>{v}</option>)}<option value="__unmapped">Region not mapped</option></select></label>
      <label>Cluster / AOM<select value={manager} onChange={e=>setManager(e.target.value)}><option value="">All clusters / AOMs</option>{options.managers.map(v=><option key={v}>{v}</option>)}<option value="__unmapped">Manager not mapped</option></select></label>
      <label>Model<select value={model} onChange={e=>setModel(e.target.value)}><option value="">All models</option>{options.models.map(v=><option key={v}>{v}</option>)}</select></label>
      {(['reconciliation','prepareDeposit','remittances'] as const).map((part,i)=><label key={part}>{['DA reconciliation status','Prepare deposit status','COD deposition status'][i]}<select value={parts[part]} onChange={e=>setParts(p=>({...p,[part]:e.target.value}))}>{statusOptions}</select></label>)}
      <label>Overall status<select value={filter} onChange={e=>setFilter(e.target.value)}>{statusOptions}</select></label>
    </div>
    <div className={styles.summary}>{Object.entries(codToneLabels).map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(filter===key?'':key)}><strong className={toneClass(key as CodTone)}>{totals[key as CodTone]}</strong><span>{label}</span></button>)}</div>
    <div className={styles.viewbar}><span><b>{visible.length}</b> of {locations.length} stations</span><div><label>Sort by <select value={sort} onChange={e=>setSort(e.target.value as CodSort)}><option value="station">Station</option><option value="region">Region</option><option value="manager">Cluster / AOM</option><option value="reconciliation">DA pending amount</option><option value="prepareDeposit">Amount to prepare</option><option value="remittances">Deposit priority</option><option value="checkedAt">Last check</option></select></label><button onClick={()=>setDirection(d=>d==='asc'?'desc':'asc')}>{direction==='asc'?'↑ Ascending':'↓ Descending'}</button><button onClick={reset}>Reset filters</button></div></div>
    <div className={styles.legend}><span className={styles.active}>● Today · within delivery hours</span><span className={styles.good}>● Complete / clear</span><span className={styles.warn}>● Pending within process</span><span className={styles.bad}>● Overdue / timing issue / difference</span><span className={styles.neutral}>● Needs verification</span></div>
    <section className={styles.tableSection} aria-label="Station COD status"><div className={styles.tableHeader}><span>Station</span><span>DA cash · {collectionDate==='undated'?'date unverified':collectionDate?dateLabel(collectionDate):'all dates'}</span><span>Prepare deposit · live</span><span>COD deposition · live</span><span>Last check · IST</span></div>
      {visible.map(l=>{const row=rows[l.id];return <Fragment key={l.id}><div className={styles.stationRow}><div className={styles.station}><strong>{l.code}</strong><span>{l.name}</span><small>{l.model}{l.region?` · ${l.region}`:''}</small><small>{l.managerRole==='Unmapped'?'Manager not mapped':`${l.managerRole || 'Cluster'}: ${l.manager}`}</small><small title={pickupExpectation(l.pickup || null,codStatusToday(now),now).message}>{l.pickup ? `${l.pickup.rule} · ${l.pickup.start}–${l.pickup.end}` : 'Pickup not configured'}</small><small>DA close: {l.reconDueTime ? `${l.reconDueTime} IST` : 'Not configured'}</small>{l.pickup?.rule==='Next Day' && <small>Prepare from {l.pickup.preparationFrom || 'Not configured'} IST</small>}</div><div data-label="DA reconciliation">{cell(l,'reconciliation')}</div><div data-label="Prepare deposit">{cell(l,'prepareDeposit')}</div><div data-label="COD deposition status">{cell(l,'remittances')}</div><div className={styles.checked}>{row?.loading?<span>Checking…</span>:<span>{time(row?.snapshot?.fetchedAt)}</span>}<button disabled={!!row?.loading} onClick={()=>refresh(l.id,true)} aria-label={`Refresh ${l.code}`}>Refresh</button></div></div>{row?.error && <p className={styles.error}>{l.code}: {row.error}</p>}{expanded?.id===l.id && row?.snapshot && <div className={styles.detail}><button className={styles.close} onClick={()=>setExpanded(null)}>Close details ×</button>{expanded.part!=='reconciliation' && <p><strong>Pickup expectation: </strong>{pickupExpectation(l.pickup || null,row.snapshot.date,now).message}{l.pickup && <> Collection date {row.snapshot.date}; pickup {pickupExpectation(l.pickup,row.snapshot.date,now).depositDate}, {l.pickup.start}–{l.pickup.end} IST.</>}</p>}<p><strong>{checks(l)[expanded.part].label}: </strong>{checks(l)[expanded.part].reason}</p>{details(row.snapshot,expanded.part,l)}</div>}</Fragment>})}
      {!visible.length && <p className={styles.empty}>{locations.length?'No stations match these filters.':'No Amazon EDSP, XPT or AMXL locations are available in your scope.'}</p>}
    </section><p className={styles.note}>Click a status for details. Pending DA cash and cash waiting for deposit are separate balances; do not add them to remittance amounts. Colours use collection dates and COD Pickup Master deadlines. Undated cash stays unverified. Earlier open records remain available in the details; timing clearance does not confirm bank settlement.</p>
  </div>;
}
