'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { codFreshness, matchesSelection, toggleCodSelection, codStatusCategory, codStatusToday, codStatusChecks, codToneLabels, classifyRemittance, matchesCodFilters, compareCodRows, type CodSort, type CodTone, type CodStatusLocation, type CodStatusSnapshot } from '@/lib/ops-pulse/cod-status';
import { reconciliationView, reconciliationAgeing, collectionDay, validCollectionDate } from '@/lib/ops-pulse/cod-reconciliation';
import { pickupExpectation } from '@/lib/ops-pulse/cod-pickup';
import { CompactFilter } from './compact-filter';
import { StationTeam } from './station-team';
import { CmsFollowUp } from './cms-followup';
import { overdueCodRemittances } from '@/lib/ops-pulse/cod-cms-followup';
import styles from './status.module.css';
type Part = 'reconciliation' | 'prepareDeposit' | 'remittances';
type Row = { snapshot?: CodStatusSnapshot; loading?: boolean; error?: string };
const amount = (n: number) => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 }).format(n);
const dateLabel = (value:string) => new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric'}).format(new Date(value+'T00:00:00+05:30'));
const time = (value: string | number | null | undefined) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true }).format(new Date(value)) : 'Not available';

export function CodStatusClient({ locations }: { locations: CodStatusLocation[] }) {
  const [rows,setRows] = useState<Record<string,Row>>({});
  const [search,setSearch] = useState('');
  const [model,setModel] = useState<string[]>([]), [manager,setManager] = useState<string[]>([]), [region,setRegion] = useState<string[]>([]), [filter,setFilter] = useState<string[]>([]), [stations,setStations]=useState<string[]>([]), [freshness,setFreshness]=useState<string[]>([]);
  const [parts,setParts] = useState<Record<Part,string[]>>({reconciliation:[],prepareDeposit:[],remittances:[]});
  const [teamLocation,setTeamLocation]=useState<CodStatusLocation|null>(null);
  const [sort,setSort] = useState<CodSort>('station'), [direction,setDirection] = useState<'asc'|'desc'>('asc');
  const [expanded,setExpanded] = useState<{id:string;part:Part;agedOnly?:boolean} | null>(null);
  const [now,setNow] = useState(() => new Date());
  const [dateMode,setDateMode] = useState('all'), [customDate,setCustomDate] = useState(()=>codStatusToday());
  const today=codStatusToday(now);
  const collectionDate=dateMode==='all'?'':dateMode==='today'?today:dateMode==='yesterday'?new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10):dateMode==='undated'?'undated':customDate;
  const cashView=(l:CodStatusLocation)=>reconciliationView(rows[l.id]?.snapshot?.reconciliation.data,collectionDate,l.reconDueTime || null,now);
  const ageing=(l:CodStatusLocation)=>reconciliationAgeing(rows[l.id]?.snapshot?.reconciliation.data,l.ageFlagDays ?? null,now);
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
      if (alive.current) {setRows(prev => ({...prev,[id]:{snapshot:data,loading:false}}));setNow(new Date());}
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
  const checks = (l:CodStatusLocation) => codStatusChecks(rows[l.id]?.snapshot,l.pickup || null,now,!!rows[l.id]?.error,collectionDate,l.reconDueTime || null,l.maxAgeMinutes ?? null);
  const status = (l:CodStatusLocation) => codStatusCategory(rows[l.id]?.snapshot,now,l.pickup || null,!!rows[l.id]?.error,collectionDate,l.reconDueTime || null,l.maxAgeMinutes ?? null);
  const selected = locations.filter(l=>matchesCodFilters(l,checks(l),status(l),{search,model,manager,region,station:stations}));
  const snapshots = Object.fromEntries(Object.entries(rows).map(([id,row])=>[id,row.snapshot]));
  const statusBase=selected.filter(l=>matchesCodFilters(l,checks(l),status(l),parts) && matchesSelection(freshness,[codFreshness(rows[l.id]?.snapshot,l.maxAgeMinutes,now,!!rows[l.id]?.loading,!!rows[l.id]?.error)]));
  const visible = statusBase.filter(l=>matchesSelection(filter,[status(l)])).sort((a,b)=>compareCodRows(a,b,snapshots,sort,direction,now,collectionDate));
  const totals:Record<CodTone,number> = {attention:0,active:0,waiting:0,clear:0,unavailable:0,unchecked:0};
  statusBase.forEach(l=>totals[status(l)]++);
  const options = useMemo(()=>({models:[...new Set(locations.map(l=>l.model).filter(Boolean))].sort(),managers:[...new Set(locations.flatMap(l=>l.managers || [l.manager]).filter(Boolean))].sort(),regions:[...new Set(locations.map(l=>l.region).filter(Boolean))].sort()}),[locations]);
  const reset = () => {setDateMode('all');setSearch('');setModel([]);setManager([]);setRegion([]);setFilter([]);setStations([]);setFreshness([]);setParts({reconciliation:[],prepareDeposit:[],remittances:[]});setSort('station');setDirection('asc');};
  const statusOptions=Object.entries(codToneLabels).map(([value,label])=>({value,label}));
  const option=(value:string)=>({value,label:value});
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
    return <><button className={`${styles.cell} ${toneClass(result.tone)}`} onClick={()=>toggle(l.id,part)} aria-expanded={expanded?.id===l.id && expanded.part===part} aria-label={`${l.code} ${part==='reconciliation'?'DA reconciliation':part==='prepareDeposit'?'prepare deposit':'COD deposition'} details`}>
      <strong>{headline} <span aria-hidden>›</span></strong><small>{detail}</small>{part==='reconciliation' && <><small>{result.reason}</small>{collectionDate && cashView(l).priorAmount>0 && <small>All dates: {amount(cashView(l).priorAmount)} earlier-day cash still outstanding</small>}</>}{part==='remittances' && s?.remittances.data?.latestSubmitted && <small>{result.reason}</small>}{part!=='reconciliation' && result.tone==='unavailable' && <small>{result.reason}</small>}
    </button>{part==='remittances' && overdueCodRemittances(s,l.pickup || null,now,!!row?.error,l.maxAgeMinutes ?? null).length>0 && <CmsFollowUp station={l.code} contact={l.cmsContact}/>}</>;
  }
  function details(s: CodStatusSnapshot, part: Part, location:CodStatusLocation) {
    if(part==='reconciliation') {
      const view=cashView(location);
      const aged=ageing(location);
      const r=expanded?.agedOnly?{...view,drivers:aged.drivers}:view;
      return <><h3>Cash with associates · {expanded?.agedOnly?`${location.ageFlagDays}+ day pending TIDs`:collectionDate==='undated'?'date unverified':collectionDate?dateLabel(collectionDate):'all collection dates'}</h3>
        <p>Current outstanding cash, grouped by Amazon’s pending-reconciliation date. Checked {time(s.reconciliation.checkedAt)} IST. This is not a historical end-of-day balance.</p>
        <div className={styles.cashDates}><span className={styles.active}>Collected today <b>{amount(r.todayAmount)}</b></span><span className={styles.bad}>Earlier days <b>{amount(r.priorAmount)}</b></span>{r.unknownDrivers>0 && <span className={styles.neutral}>Date unverified <b>{amount(r.unknownAmount)}</b> · {r.unknownDrivers} DA</span>}</div>
        <p>DA closing time: <b>{location.reconDueTime ? `${location.reconDueTime} IST` : 'Not configured in COD Pickup Master'}</b>. Dates come from Amazon’s pending-reconciliation records. Where collection time is absent, Amazon uses the pending transaction time; those rows are labelled. Neither date is the OpsPulse refresh time.</p>
        {!r.drivers.length ? <p>{r.check.reason}</p> : <div className={styles.drivers}>{r.drivers.map(d=><details key={d.id} open={expanded?.agedOnly || undefined}><summary><span><b>{d.name}</b><small>{d.id}</small></span><strong>{amount(d.pendingAmount)}</strong></summary>{d.packages.length ? <div className={styles.scroll}><table><thead><tr><th>Tracking ID (TID)</th><th>COD / pending since · IST</th><th>Last COD transaction · IST</th><th>Age / status</th><th>Pending amount</th></tr></thead><tbody>{d.packages.map((p,i)=>{
          const day=collectionDay(p.collectedAt,now);
          const age=day?Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(day+'T00:00:00Z'))/86400000):null;
          const overdue=age!==null && (age>0 || !!location.reconDueTime && now.getTime()>=Date.parse(`${today}T${location.reconDueTime}:00+05:30`));
          return <tr key={`${p.trackingId}-${i}`}><td>{p.trackingId}<small>{p.paymentMethod}</small></td><td>{time(p.collectedAt)}{p.dateSource==='pending_transaction' && <small>Pending transaction · Amazon date</small>}</td><td>{time(p.transactionAt)}</td><td><span className={age===null?styles.neutral:overdue?styles.bad:styles.active}>{age===null?'Date unverified':age>0?`${age} day${age===1?'':'s'} · overdue`:overdue?'Today · overdue':'Today'}</span></td><td>{amount(p.amount)}</td></tr>;
        })}</tbody></table></div>:<p>No shipment-level dates were returned by the portal for this balance.</p>}</details>)}</div>}
      </>;
    }
    if(part==='prepareDeposit') {
      const p=s.prepareDeposit.data;
      return <><h3>Cash waiting for prepare deposit</h3><p>All outstanding cash from Amazon’s Prepare Deposit overview, including earlier dates. Checked {time(s.prepareDeposit.checkedAt)} IST.</p>{p && <div className={styles.amounts}><div><small>Expected cash</small><strong>{amount(p.expectedAmount)}</strong></div><div><small>Actual cash</small><strong>{amount(p.actualAmount)}</strong></div><div><small>Short / excess</small><strong>{amount(p.variance)}</strong></div></div>}{p?.digitalAmount!=null && <p>Digital liability: <b>{amount(p.digitalAmount)}</b> · shown separately; not added to physical cash.</p>}<p>Preparing a deposit and submitting a remittance are separate steps. Complete the transaction in Amazon.</p></>;
    }
    const m=s.remittances.data;
    return <><h3>COD remittance details</h3><p>Portal window: {time(s.remittanceWindow.startTime)} – {time(s.remittanceWindow.endTime)} IST. Records outside this window are not checked here. “Submitted” is Amazon’s status; it does not confirm bank settlement.</p>{!m?.complete && <p className={styles.warning}>The source check is incomplete. Do not treat the absence of an open remittance as clearance.</p>}<div className={styles.scroll}><table><thead><tr><th>Remittance</th><th>Portal status</th><th>Pickup assessment</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Created</th><th>Last updated · IST</th><th>Submitted by</th></tr></thead><tbody>{m?.rows.map(r=>{const assessment=['CREATED','PENDING_SUBMISSION'].includes(r.status.toUpperCase())?classifyRemittance(r,m.latestSubmitted,location.pickup || null,now):null;return <tr key={r.id}><td><strong>{r.code||'Code not issued'}</strong></td><td><span className={['CREATED','PENDING_SUBMISSION'].includes(r.status)?styles.warn:styles.neutral}>{r.status}</span></td><td>{assessment?<span className={`${styles.assessment} ${toneClass(assessment.tone)}`} title={assessment.reason}>{assessment.label}</span>:'—'}</td><td>{amount(r.expectedAmount)}</td><td>{amount(r.actualAmount)}</td><td>{amount(r.variance)}</td><td>{time(r.createdAt)}</td><td>{time(r.updatedAt)}</td><td>{r.submittedBy||'—'}</td></tr>;})}</tbody></table>{!m?.rows.length && <p>No remittances returned in this portal window.</p>}</div></>;
  }
  return <div className={styles.root}>
    <div className={styles.toolbar}><div><strong>Today · {now.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'})}</strong><small>{locations.length} authorized locations · All times IST</small></div><button className={styles.refresh} disabled={refreshing} onClick={()=>refreshMany(visible.map(l=>l.id),true)}>{refreshing?'Checking stations…':'Refresh selected stations'}</button></div>
    <section className={styles.dateBar} aria-label="COD collection date">
      <div><strong>COD collection date</strong><small>Filter cash by its collection / pending date in Amazon.</small></div>
      <label className={styles.dateSelect}>Show<select aria-label="COD collection date filter" value={dateMode} onChange={e=>setDateMode(e.target.value)}><option value="all">All outstanding dates</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="custom">Choose date</option><option value="undated">Date unverified</option></select></label>
      {dateMode==='custom' && <label>Collection date<input type="date" aria-label="Collection date" value={customDate} max={today} onChange={e=>{if(validCollectionDate(e.target.value,today))setCustomDate(e.target.value);}}/></label>}
      <small>Prepare Deposit and Remittances remain live balances; the portal does not attribute those totals to a collection date.</small>
    </section>
    <div className={styles.filters}>
      <input aria-label="Find station" placeholder="Find station…" value={search} onChange={e=>setSearch(e.target.value)} />
      <CompactFilter label="Region" values={region} onChange={setRegion} options={[...options.regions.map(option),{value:'__unmapped',label:'Region not mapped'}]}/>
      <CompactFilter label="Cluster / AOM" values={manager} onChange={setManager} options={[...options.managers.map(option),{value:'__unmapped',label:'Manager not mapped'}]}/>
      <CompactFilter label="Model" values={model} onChange={setModel} options={options.models.map(option)}/>
      <CompactFilter label="Overall status" values={filter} onChange={setFilter} options={statusOptions}/>
    </div>
    <div className={styles.summary} aria-label="Filter by overall status">{Object.entries(codToneLabels).map(([key,label])=><button key={key} aria-pressed={filter.includes(key)} title={`Toggle ${label} stations`} onClick={()=>setFilter(current=>toggleCodSelection(current,key))}><strong className={toneClass(key as CodTone)}>{totals[key as CodTone]}</strong><span>{label}<small>{filter.includes(key)?'✓ Selected · click to remove':'Click to filter'}</small></span></button>)}</div>
    <div className={styles.viewbar}><span><b>{visible.length}</b> of {locations.length} stations</span><div><label>Sort by <select value={sort} onChange={e=>setSort(e.target.value as CodSort)}><option value="station">Station</option><option value="region">Region</option><option value="manager">Cluster / AOM</option><option value="reconciliation">DA pending amount</option><option value="prepareDeposit">Amount to prepare</option><option value="remittances">Deposit priority</option><option value="checkedAt">Last check</option></select></label><button onClick={()=>setDirection(d=>d==='asc'?'desc':'asc')}>{direction==='asc'?'↑ Ascending':'↓ Descending'}</button><button onClick={reset}>Reset filters</button></div></div>
    <div className={styles.legend}><span className={styles.active}>● Today · within delivery hours</span><span className={styles.good}>● Complete / clear</span><span className={styles.warn}>● Pending within process</span><span className={styles.bad}>● Overdue / timing issue / difference</span><span className={styles.neutral}>● Needs verification</span></div>
    <section className={styles.tableSection} aria-label="Station COD status"><div className={styles.tableHeader}>
      <div><span>Station</span><CompactFilter label="Stations" values={stations} onChange={setStations} options={locations.map(l=>({value:l.id,label:`${l.code} · ${l.name}`}))}/></div>
      {(['reconciliation','prepareDeposit','remittances'] as const).map((part,i)=><div key={part}><span>{i===0?`DA cash · ${collectionDate==='undated'?'date unverified':collectionDate?dateLabel(collectionDate):'all dates'}`:i===1?'Prepare deposit · live':'COD deposition · live'}</span><CompactFilter label={['DA status','Prepare status','Deposition status'][i]} values={parts[part]} onChange={values=>setParts(p=>({...p,[part]:values}))} options={statusOptions}/></div>)}
      <div><span>Last check · IST</span><CompactFilter label="Last check" values={freshness} onChange={setFreshness} options={[{value:'fresh',label:'Fresh'},{value:'stale',label:'Refresh due'},{value:'failed',label:'Check failed'},{value:'checking',label:'Checking'},{value:'unchecked',label:'Not checked'}]}/></div>
    </div>
      {visible.map(l=>{const row=rows[l.id];return <Fragment key={l.id}><div className={styles.stationRow}><div className={styles.station}>
        <button className={styles.stationTitle} onClick={()=>setTeamLocation(l)} aria-label={`${l.code} station team details`}><strong>{l.code}</strong><span>{l.name}</span><span aria-hidden>›</span></button>
        <small>{l.model}{l.region?` · ${l.region}`:''} · {l.managerRole==='Unmapped'?'Manager not mapped':`${l.managerRole || 'Cluster'}: ${l.manager}`}</small>
        <div className={styles.lead}>{l.leads?.length?<><button onClick={()=>setTeamLocation(l)} title={l.leads[0].role}>{l.leads[0].role} · {l.leads[0].name}{l.leads.length>1?` +${l.leads.length-1}`:''}</button>{l.leads[0].phone?<a href={`tel:${l.leads[0].phone.replace(/[^+\d]/g,'')}`}>{l.leads[0].phone}</a>:<small>Phone not added</small>}</>:<button onClick={()=>setTeamLocation(l)}>{l.teamUnavailable?'Team unavailable · retry':'TL not mapped · view team'}</button>}<button className={styles.teamLink} onClick={()=>setTeamLocation(l)}>Team & shifts ↗</button></div>
        <details className={styles.schedule}><summary>CMS {l.pickup ? `${l.pickup.start}–${l.pickup.end}` : 'not set'} · DA close {l.reconDueTime || 'not set'}</summary><span>{l.pickup?.rule || 'Configure pickup'}{l.pickup?.rule==='Next Day' ? ` · Prepare ≥ ${l.pickup.preparationFrom || 'not set'}` : ''}</span><span>{pickupExpectation(l.pickup || null,codStatusToday(now),now).message}</span></details>
      </div><div data-label="DA reconciliation">{cell(l,'reconciliation')}{ageing(l).count>0 && <button className={styles.ageFlag} onClick={()=>setExpanded({id:l.id,part:'reconciliation',agedOnly:true})} aria-label={`${l.code} ${l.ageFlagDays}+ day pending TIDs`}><b>⚑ {l.ageFlagDays}+ day · {ageing(l).count} TIDs</b><span>{amount(ageing(l).amount)} · oldest {ageing(l).oldestDays}d ›</span></button>}</div><div data-label="Prepare deposit">{cell(l,'prepareDeposit')}</div><div data-label="COD deposition status">{cell(l,'remittances')}</div><div className={styles.checked}>{row?.loading?<span>Checking…</span>:<span>{time(row?.snapshot?.fetchedAt)}</span>}<button disabled={!!row?.loading} onClick={()=>refresh(l.id,true)} aria-label={`Refresh ${l.code}`}>Refresh</button></div></div>{row?.error && <p className={styles.error}>{l.code}: {row.error}</p>}{expanded?.id===l.id && row?.snapshot && <div className={styles.detail}><button className={styles.close} onClick={()=>setExpanded(null)}>Close details ×</button>{expanded.part!=='reconciliation' && <p><strong>Pickup expectation: </strong>{pickupExpectation(l.pickup || null,row.snapshot.date,now).message}{l.pickup && <> CMS {l.pickup.start}–{l.pickup.end} IST. Remittance timing below uses its own creation date; no collection date is inferred from this refresh.</>}</p>}<p><strong>{checks(l)[expanded.part].label}: </strong>{checks(l)[expanded.part].reason}</p>{details(row.snapshot,expanded.part,l)}</div>}</Fragment>})}
      {!visible.length && <p className={styles.empty}>{locations.length?'No stations match these filters.':'No Amazon EDSP, XPT or AMXL locations are available in your scope.'}</p>}
    </section><p className={styles.note}>Click a status for details. Pending DA cash and cash waiting for deposit are separate balances; do not add them to remittance amounts. Colours use Amazon COD dates and COD Pickup Master deadlines. Undated cash stays unverified. Earlier open records remain available in the details; timing clearance does not confirm bank settlement.</p>
    {teamLocation && <StationTeam key={teamLocation.id} location={teamLocation} onClose={()=>setTeamLocation(null)}/>}
  </div>;
}
