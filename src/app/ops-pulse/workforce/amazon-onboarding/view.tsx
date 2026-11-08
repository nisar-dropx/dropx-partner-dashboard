'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {Users,UserPlus,UserCheck,UserMinus,History,RefreshCw,Search,ChevronDown,ArrowRight} from 'lucide-react';
import { queueAmazonInvitationFromOpsPulse } from '@/app/field-executive/actions';
import type { AmazonDaPerson, AmazonDaCommand, AmazonDaList } from '@/lib/amazon-da-desk-types';
import {Profile,Audit} from './profile';
import {Approvals} from './approvals';
import {BgcPanel} from './bgc';
import {BulkBgc} from './bulk-bgc';
import styles from './view.module.css';
type InviteData={people:Array<{id:string;full_name:string;dropx_id:string|null;email:string|null;onboarding_status:string;inviteBlocked?:string|null}>;requests:Array<{id:string;workforce_id:string;status:string;requested_at:string;error_message:string|null}>};
type DeskData=Partial<AmazonDaList>&Partial<InviteData>&{commands?:AmazonDaCommand[];canApprove?:boolean;moreHistory?:boolean};
const tabs=[['onboarding','Onboarding',UserPlus],['associates','My associates',Users],['bgc-pending','BGC / IDfy',UserCheck],['offboarded','Offboarded',UserMinus],['invite','Invite',UserCheck],['approvals','Approvals',UserCheck],['history','History',History]] as const;
const human=(v:string|null|undefined)=>v?v.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/^\w/,c=>c.toUpperCase()):'';
const date=(v:string)=>new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});
async function api<T>(url:string,signal?:AbortSignal):Promise<T>{const res=await fetch(url,{cache:'no-store',signal});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load this view.');return data;}
function Photo({person,station}:{person:AmazonDaPerson;station:string}){
 const [failed,setFailed]=useState(false);
 const src=person.photoUrl||(person.photoTicket?`/api/ops-pulse/amazon-da?${new URLSearchParams({view:'photo',station,profile:person.providerId,ticket:person.photoTicket})}`:null);
 useEffect(()=>setFailed(false),[src]);
 return <span className={styles.avatar}>{src&&!failed?<img src={src} alt="" width={52} height={52} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span>{person.name.trim().split(/\s+/).slice(0,2).map(n=>n[0]).join('')}</span>}</span>;
}
export function AmazonDaDesk({stations,canEdit,initialView='onboarding',initialStation,notice,initialError}:{stations:Array<{id:string;code:string}>;canEdit:boolean;initialView?:string;initialStation?:string;notice?:string;initialError?:string}){
 const [station,setStation]=useState(stations.some(s=>s.id===initialStation)?initialStation!:stations[0]?.id||'');
 const [allScope,setAllScope]=useState(initialView==='approvals'||initialView==='history'),[historyPage,setHistoryPage]=useState(0);
 const [view,setView]=useState(initialView);const [query,setQuery]=useState('');const [debouncedQuery,setDebouncedQuery]=useState('');const [statusFilter,setStatusFilter]=useState('');
 const [data,setData]=useState<DeskData>({});const [dataKey,setDataKey]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [expanded,setExpanded]=useState('');
 const [revision,setRevision]=useState(0);const [moreBusy,setMoreBusy]=useState(false);const requestSeq=useRef(0);const force=useRef(false);const cache=useRef(new Map<string,{data:DeskData;at:number}>());
 const isBgc=view==='bgc'||view==='bgc-pending';const isList=['onboarding','associates','offboarded','bgc','bgc-pending'].includes(view);const auditView=['history','approvals'].includes(view);const requestStation=auditView&&allScope?'all':station;const key=`${requestStation}:${view}:${isList?debouncedQuery:''}:${statusFilter}:${historyPage}`;const current=dataKey===key?data:{};const rows=current.rows||[];
 useEffect(()=>{const timer=setTimeout(()=>setDebouncedQuery(query.trim()),300);return()=>clearTimeout(timer);},[query]);
 function resetFilters(){setExpanded('');setQuery('');setDebouncedQuery('');setStatusFilter('');setHistoryPage(0);}
 function refresh(){cache.current.clear();force.current=true;setRevision(n=>n+1);}
 function listUrl(offset=0,snapshot=''){
  const p=new URLSearchParams({station:requestStation,view});if(auditView)p.set('offset',String(historyPage*50));if(isList){p.set('pageSize','24');p.set('offset',String(offset));p.set('query',debouncedQuery);p.set('status',statusFilter);if(snapshot)p.set('snapshot',snapshot);if(force.current)p.set('fresh','1');}return `/api/ops-pulse/amazon-da?${p}`;
 }
 useEffect(()=>{
  if(!station)return;const seq=++requestSeq.current;const controller=new AbortController();setError('');setExpanded('');setMoreBusy(false);
  const saved=cache.current.get(key);if(saved&&!force.current&&Date.now()-saved.at<25_000){setData(saved.data);setDataKey(key);setBusy(false);return()=>{requestSeq.current++;};}
  setBusy(true);setData({});setDataKey(key);const url=listUrl();force.current=false;
  api<DeskData>(url,controller.signal).then(result=>{if(seq!==requestSeq.current)return;setData(result);if(cache.current.size>=8)cache.current.delete(cache.current.keys().next().value!);cache.current.set(key,{data:result,at:Date.now()});})
   .catch(e=>{if(seq===requestSeq.current&&e.name!=='AbortError')setError(e.message);}).finally(()=>{if(seq===requestSeq.current)setBusy(false);});
  return()=>{controller.abort();requestSeq.current++;};
 // The key includes every server filter; revision is explicit invalidation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,revision]);
 async function loadMore(){if(current.nextOffset==null||moreBusy)return;const seq=requestSeq.current;setMoreBusy(true);setError('');try{const next=await api<AmazonDaList>(listUrl(current.nextOffset,current.snapshot));if(seq!==requestSeq.current)return;const merged=next.reset?next:{...next,rows:[...new Map([...rows,...next.rows].map(p=>[p.providerId,p])).values()]};setData(merged);cache.current.set(key,{data:merged,at:Date.now()});}catch(e){if(seq===requestSeq.current)setError((e as Error).message);}finally{if(seq===requestSeq.current)setMoreBusy(false);}}
 const filtered=rows.filter(r=>`${r.name} ${r.email||''} ${r.transporterId||''}`.toLowerCase().includes(query.trim().toLowerCase()));const invite=current.people||[];
 return <section className={styles.desk} aria-busy={busy}>
  {notice?<p role="status" className={styles.next}>{notice}</p>:null}{initialError?<p role="alert" className={styles.error}>{initialError}</p>:null}
  <div className={styles.toolbar}>
   <label className={styles.station}>Station<select value={auditView&&allScope?'all':station} onChange={e=>{setAllScope(e.target.value==='all');if(e.target.value!=='all')setStation(e.target.value);resetFilters();}} aria-label="Amazon station">{auditView?<option value="all">All my stations</option>:null}{stations.map(s=><option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
   <nav className={styles.tabs} aria-label="Amazon associates">{tabs.map(([id,label,Icon])=><button key={id} type="button" aria-pressed={view===id||(id==='bgc-pending'&&isBgc)} onClick={()=>{setView(id);setAllScope(id==='approvals'||id==='history');resetFilters();}}><Icon size={15} aria-hidden="true"/>{label}</button>)}</nav>
   <button className={styles.refresh} type="button" onClick={refresh} disabled={busy||!station} aria-label="Refresh Amazon data" title="Refresh Amazon data"><RefreshCw size={16} className={busy?styles.spin:''}/><span>Refresh</span></button>
  </div>
  {!stations.length?<p className={styles.empty}>No Amazon stations are in your access.</p>:null}
  {error?<div role="alert" className={styles.error}>{error}<button onClick={refresh}>Retry</button></div>:null}
  {isList?<>
   {isBgc?<div className={styles.split}><div className={styles.milestoneFilters}><button aria-pressed={view==='bgc-pending'} onClick={()=>{setView('bgc-pending');resetFilters();}}>Needs information</button><button aria-pressed={view==='bgc'} onClick={()=>{setView('bgc');resetFilters();}}>All BGC profiles</button></div><small>Current station access · verified Amazon identity</small></div>:null}
   <div className={styles.filters}><label className={styles.search}><Search size={16}/><input aria-label="Search associates" placeholder="Find a name, Amazon ID or email" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {view==='associates'?<select aria-label="Filter associate status" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>:null}
    <span className={styles.resultCount}>{busy?'Loading…':`${filtered.length} shown${current.nextOffset!=null?' · more available':''}`}</span>{current.checkedAt?<span className={styles.updated}>Updated {date(current.checkedAt)} IST</span>:null}
   </div>
   {busy?<div className={styles.skeletonGrid} role="status" aria-label="Loading associates">{[0,1,2,3,4,5].map(n=><div key={n} className={styles.skeleton}><span/><div><i/><i/></div></div>)}</div>:null}
   {isBgc?<BulkBgc key={key} station={station} people={filtered}/>:null}
   <div className={styles.list}>{filtered.map(person=>{const open=expanded===person.providerId;const behind=/behind|blocked|error/i.test(person.health||'');return <article className={`${styles.card} ${open?styles.expanded:''}`} key={person.providerId}>
    <button className={styles.row} aria-expanded={open} aria-label={`View ${person.name}`} onClick={()=>setExpanded(open?'':person.providerId)}>
     <Photo person={person} station={station}/><span className={styles.identity}><strong>{person.name}</strong><small>{person.transporterId||'Amazon ID pending'}</small><span className={`${styles.badge} ${behind?styles.danger:person.status==='ACTIVE'||person.health==='ON_TRACK'?styles.good:person.status==='OFFBOARDED'?styles.muted:styles.warning}`}>{human(person.health||person.status)}</span></span><ChevronDown size={17} className={open?styles.chevronOpen:styles.chevron}/>
     {isBgc?<span className={styles.stage}><span>{person.bgc?.status||'Status not synced yet'}</span><strong>{person.bgc?.address?.label||(person.bgc?.reportAvailable?'Report available':'')}</strong></span>:null}
     {!isBgc&&person.stage?<span className={styles.stage}><span>{human(person.stage)}</span>{person.progress!=null?<strong>{person.completedSteps}/{person.totalSteps} steps</strong>:null}</span>:null}
     {!isBgc&&person.progress!=null?<progress className={styles.progress} max="100" value={person.progress} aria-label={`${person.progress}% onboarding complete`}/>:null}
     <span className={styles.cardAction}>{open?'Close details':'View profile'}<ArrowRight size={13}/></span>
    </button>
    {open&&isBgc?<div className={styles.profile}><BgcPanel station={station} providerId={person.providerId} initial={person.bgc} canEdit={canEdit}/></div>:open?<Profile key={`${station}:${person.providerId}`} station={station} providerId={person.providerId} initialPerson={person} canEdit={canEdit} onChanged={refresh}/>:null}
   </article>;})}</div>
   {!busy&&!error&&!filtered.length?<div className={styles.empty}><Users size={28}/><strong>No associates found</strong><span>{query?'Try another name or Amazon ID.':'No records in this view for the selected station.'}</span></div>:null}
   {current.reset?<p role="status" className={styles.meta}>Amazon data changed. The list has restarted with the latest results.</p>:null}
   {current.nextOffset!=null&&!busy?<button className={styles.loadMore} onClick={()=>void loadMore()} disabled={moreBusy}>{moreBusy?'Loading…':'Load more associates'}<ChevronDown size={15}/></button>:null}
  </>:view==='invite'?<div className={styles.invite}>
   <div className={styles.split}><div><strong>Invite an associate</strong><small>Choose a registered DropX profile.</small></div><Link href="/work-force-register"><UserPlus size={15}/> Register new</Link></div>
   <label className={styles.search}><Search size={16}/><input aria-label="Find registered associate" placeholder="Search name or DropX ID" value={query} onChange={e=>setQuery(e.target.value)}/></label>
   {busy?<p className={styles.meta}>Loading registered associates…</p>:null}
   {invite.filter(p=>`${p.full_name} ${p.dropx_id||''}`.toLowerCase().includes(query.toLowerCase())).map(p=>{const latest=current.requests?.find(r=>r.workforce_id===p.id);return <div className={styles.inviteRow} key={p.id}><div><strong>{p.full_name}</strong><small>{p.dropx_id||'DropX ID pending'} · {p.email||'Email missing'}</small>{p.inviteBlocked?<small>{p.inviteBlocked}</small>:latest?<small className={latest.status==='failed'?styles.danger:''}>{human(latest.status)} · {date(latest.requested_at)} {latest.error_message||''}</small>:null}</div>
    <form action={queueAmazonInvitationFromOpsPulse}><input type="hidden" name="workforce_id" value={p.id}/><input type="hidden" name="amazon_desk_return" value="1"/><input type="hidden" name="amazon_desk_station" value={station}/><button disabled={!canEdit||!p.email||!!p.inviteBlocked||['sent','processing','pending','queued'].includes(latest?.status||'')} type="submit">{p.inviteBlocked?'Unavailable':latest?.status==='sent'?'Sent':latest?.status==='failed'?'Retry invite':'Send invite'}</button></form></div>;})}
   {!busy&&!invite.length?<p className={styles.empty}>No registered associates at this station.</p>:null}
  </div>:busy?<p className={styles.meta}>Loading requests…</p>:<>{view==='approvals'?<Approvals commands={current.commands||[]} stations={stations} canApprove={!!current.canApprove} onChanged={refresh}/>:<Audit commands={current.commands||[]} station={station} canEdit={canEdit} onChecked={refresh}/>}<div className={styles.reviewButtons}>{historyPage>0?<button onClick={()=>setHistoryPage(n=>n-1)}>Previous</button>:null}{current.moreHistory?<button onClick={()=>setHistoryPage(n=>n+1)}>Next 50</button>:null}</div></>}
 </section>;
}
