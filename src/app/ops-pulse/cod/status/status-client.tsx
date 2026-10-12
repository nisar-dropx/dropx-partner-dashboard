'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { codStatusCategory, codStatusToday, type CodStatusLocation, type CodStatusSnapshot } from '@/lib/ops-pulse/cod-status';
import styles from './status.module.css';
type Part = 'reconciliation' | 'prepareDeposit' | 'remittances';
type Row = { snapshot?: CodStatusSnapshot; loading?: boolean; error?: string };
const amount = (n: number) => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 }).format(n);
const time = (value: string | number | null | undefined) => value ? new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true }).format(new Date(value)) : 'Not available';

export function CodStatusClient({ locations }: { locations: CodStatusLocation[] }) {
  const [rows,setRows] = useState<Record<string,Row>>({});
  const [search,setSearch] = useState(''), [model,setModel] = useState(''), [manager,setManager] = useState(''), [filter,setFilter] = useState('');
  const [expanded,setExpanded] = useState<{id:string;part:Part} | null>(null);
  const [now,setNow] = useState(() => new Date());
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
  const status = (row: Row | undefined) => row?.error || (row?.snapshot && now.getTime()-Date.parse(row.snapshot.fetchedAt)>15*60000) ? 'unavailable' : codStatusCategory(row?.snapshot,now);
  const selected = locations.filter(l=>(!model || l.model===model) && (!manager || l.manager===manager) && `${l.code} ${l.name}`.toLowerCase().includes(search.toLowerCase()));
  const visible = selected.filter(l=>!filter || status(rows[l.id])===filter);
  const totals = {attention:0,clear:0,unavailable:0,unchecked:0};
  selected.forEach(l=>totals[status(rows[l.id])]++);
  const options = useMemo(()=>({models:[...new Set(locations.map(l=>l.model).filter(Boolean))].sort(),managers:[...new Set(locations.map(l=>l.manager).filter(Boolean))].sort()}),[locations]);
  const toggle = (id: string,part: Part) => setExpanded(prev=>prev?.id===id && prev.part===part ? null : {id,part});
  function cell(l: CodStatusLocation,part: Part) {
    const row=rows[l.id], s=row?.snapshot, component=s?.[part];
    const old = !!s && (s.date!==codStatusToday(now) || now.getTime()-Date.parse(s.fetchedAt)>15*60000 || !!row?.error);
    if (!component?.data) return <div className={styles.unknown}>{row?.loading ? 'Checking…' : row?.error ? 'Check unavailable' : component ? 'Check unavailable' : 'Waiting to check'}{!row?.loading && <button className={styles.retry} onClick={()=>refresh(l.id,true)}>Retry station</button>}</div>;
    let headline='', detail='', tone=styles.neutral;
    if (part==='reconciliation') {
      const r=s!.reconciliation.data!;
      headline=r.pendingCount ? `${r.pendingCount} DA · ${amount(r.pendingAmount)}` : r.complete ? '100% reconciled' : 'Partial check';
      detail=r.complete ? `${r.driverCount-r.pendingCount} of ${r.driverCount} DA reconciled` : 'Some driver records could not be verified';
      tone=r.pendingCount ? styles.warn : r.complete ? styles.good : styles.neutral;
    } else if (part==='prepareDeposit') {
      const p=s!.prepareDeposit.data!;
      const pending=[p.expectedAmount,p.actualAmount,p.variance].some(v=>Math.abs(v)>=0.01);
      headline=pending ? `${amount(p.expectedAmount)} to prepare` : 'Zero balance';
      detail=pending ? `Actual cash ${amount(p.actualAmount)}${p.variance ? ' · Cash difference':''}` : 'No cash waiting to be prepared';
      tone=pending ? styles.warn : styles.good;
    } else {
      const m=s!.remittances.data!;
      headline=m.openCount ? `${m.openCount} open · ${amount(m.openAmount)}` : !m.complete ? 'Partial check' : m.submittedToday ? 'Submitted today' : 'No submission updated today';
      detail=m.latestSubmitted ? `${m.latestSubmitted.code || 'No code'} · ${time(m.latestSubmitted.updatedAt)}` : 'No submitted remittance in portal window';
      if (!m.complete) detail='Some source records could not be verified';
      tone=m.openCount ? styles.warn : m.complete && m.submittedToday ? styles.good : styles.neutral;
    }
    return <button className={`${styles.cell} ${old?styles.neutral:tone}`} onClick={()=>toggle(l.id,part)} aria-expanded={expanded?.id===l.id && expanded.part===part} aria-label={`${l.code} ${part==='reconciliation'?'DA reconciliation':part==='prepareDeposit'?'prepare deposit':'COD deposition'} details`}>
      <strong>{headline} <span aria-hidden>›</span></strong><small>{detail}</small>{old && <small>Previous check · refresh required</small>}
    </button>;
  }
  function details(s: CodStatusSnapshot, part: Part) {
    if(part==='reconciliation') {
      const r=s.reconciliation.data;
      return <><h3>Pending DA reconciliation</h3><p>Overall pending balance from Amazon, including earlier days. Checked {time(s.reconciliation.checkedAt)} IST.</p>{!r ? <p>Source unavailable.</p> : !r.drivers.length ? <p>{r.complete?'All returned DA balances are reconciled.':'Driver coverage is incomplete; completion cannot be confirmed.'}</p> : <div className={styles.drivers}>{r.drivers.map(d=><details key={d.id}><summary><span><b>{d.name}</b><small>{d.id}</small></span><strong>{amount(d.pendingAmount)}</strong></summary>{d.packages.length ? <table><thead><tr><th>Tracking ID</th><th>Payment</th><th>Pending amount</th></tr></thead><tbody>{d.packages.map((p,i)=><tr key={`${p.trackingId}-${i}`}><td>{p.trackingId}</td><td>{p.paymentMethod}</td><td>{amount(p.amount)}</td></tr>)}</tbody></table>:<p>No shipment-level breakdown was returned by the portal.</p>}</details>)}</div>}</>;
    }
    if(part==='prepareDeposit') {
      const p=s.prepareDeposit.data;
      return <><h3>Cash waiting for prepare deposit</h3><p>Matches Amazon’s Prepare Deposit overview. Checked {time(s.prepareDeposit.checkedAt)} IST.</p>{p && <div className={styles.amounts}><div><small>Expected cash</small><strong>{amount(p.expectedAmount)}</strong></div><div><small>Actual cash</small><strong>{amount(p.actualAmount)}</strong></div><div><small>Short / excess</small><strong>{amount(p.variance)}</strong></div></div>}<p>Preparing a deposit and submitting a remittance are separate steps. Complete the transaction in Amazon.</p></>;
    }
    const m=s.remittances.data;
    return <><h3>COD remittance details</h3><p>Portal window: {time(s.remittanceWindow.startTime)} – {time(s.remittanceWindow.endTime)} IST. Records outside this window are not checked here. “Submitted” is Amazon’s status; it does not confirm bank settlement.</p>{!m?.complete && <p className={styles.warning}>The source check is incomplete. Do not treat the absence of an open remittance as clearance.</p>}<div className={styles.scroll}><table><thead><tr><th>Remittance</th><th>Status</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Created</th><th>Last updated · IST</th><th>Submitted by</th></tr></thead><tbody>{m?.rows.map(r=><tr key={r.id}><td><strong>{r.code||'Code not issued'}</strong></td><td><span className={r.status==='CREATED'?styles.warn:styles.neutral}>{r.status}</span></td><td>{amount(r.expectedAmount)}</td><td>{amount(r.actualAmount)}</td><td>{amount(r.variance)}</td><td>{time(r.createdAt)}</td><td>{time(r.updatedAt)}</td><td>{r.submittedBy||'—'}</td></tr>)}</tbody></table>{!m?.rows.length && <p>No remittances returned in this portal window.</p>}</div></>;
  }
  return <div className={styles.root}>
    <div className={styles.toolbar}><div><strong>Today · {now.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'})}</strong><small>{locations.length} authorized locations · All times IST</small></div><button className={styles.refresh} disabled={refreshing} onClick={()=>refreshMany(selected.map(l=>l.id),true)}>{refreshing?'Checking stations…':'Refresh selected stations'}</button></div>
    <div className={styles.filters}><label>Find station<input placeholder="Station code or name" value={search} onChange={e=>setSearch(e.target.value)} /></label><label>Model<select value={model} onChange={e=>setModel(e.target.value)}><option value="">All models</option>{options.models.map(v=><option key={v}>{v}</option>)}</select></label><label>Cluster manager<select value={manager} onChange={e=>setManager(e.target.value)}><option value="">All cluster managers</option>{options.managers.map(v=><option key={v}>{v}</option>)}</select></label><label>Status<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">All statuses</option><option value="attention">Action needed</option><option value="clear">Clear · submitted today</option><option value="unavailable">Needs verification</option><option value="unchecked">Not checked yet</option></select></label></div>
    <div className={styles.summary}>{[['attention','Action needed'],['clear','Clear · submitted today'],['unavailable','Needs verification'],['unchecked','Not checked yet']].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(filter===key?'':key)}><strong>{totals[key as keyof typeof totals]}</strong><span>{label}</span></button>)}</div>
    <section className={styles.tableSection} aria-label="Station COD status"><div className={styles.tableHeader}><span>Station</span><span>DA reconciliation</span><span>Prepare deposit</span><span>COD deposition status</span><span>Last check · IST</span></div>
      {visible.map(l=>{const row=rows[l.id];return <Fragment key={l.id}><div className={styles.stationRow}><div className={styles.station}><strong>{l.code}</strong><span>{l.name}</span><small>{l.model}{l.region?` · ${l.region}`:''}</small></div><div data-label="DA reconciliation">{cell(l,'reconciliation')}</div><div data-label="Prepare deposit">{cell(l,'prepareDeposit')}</div><div data-label="COD deposition status">{cell(l,'remittances')}</div><div className={styles.checked}>{row?.loading?<span>Checking…</span>:<span>{time(row?.snapshot?.fetchedAt)}</span>}<button disabled={!!row?.loading} onClick={()=>refresh(l.id,true)} aria-label={`Refresh ${l.code}`}>Refresh</button></div></div>{row?.error && <p className={styles.error}>{l.code}: {row.error}</p>}{expanded?.id===l.id && row?.snapshot && <div className={styles.detail}><button className={styles.close} onClick={()=>setExpanded(null)}>Close details ×</button>{details(row.snapshot,expanded.part)}</div>}</Fragment>})}
      {!visible.length && <p className={styles.empty}>{locations.length?'No stations match these filters.':'No Amazon EDSP, XPT or AMXL locations are available in your scope.'}</p>}
    </section><p className={styles.note}>Click a status for details. Pending DA cash and cash waiting for deposit are separate balances; do not add them to remittance amounts. A previous deposit does not confirm today’s completion.</p>
  </div>;
}
