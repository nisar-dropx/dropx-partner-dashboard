'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {Users,UserPlus,UserCheck,UserMinus,History,RefreshCw,Search,ChevronDown,ArrowRight} from 'lucide-react';
import { queueAmazonInvitationFromOpsPulse } from '@/app/field-executive/actions';
import type { AmazonDaPerson, AmazonDaCommand, AmazonDaList } from '@/lib/amazon-da-desk-types';
import {Profile,Audit} from './profile';
import {Approvals} from './approvals';
import {BgcPanel} from './bgc';
import {BulkBgc} from './bulk-bgc';
import {BgcQueue} from './bgc-queue';
import {facetRows} from '@/lib/dependent-filters';
import {FleetMultiSelect,type FleetFilterOption} from '@/components/fleet-multi-select';
import {emptyDeskFilters,addressPending,needsInformation,type DeskFilters,type DeskPerson} from '@/lib/amazon-da-filters';
import styles from './view.module.css';
type InviteData={people:Array<{id:string;full_name:string;dropx_id:string|null;email:string|null;onboarding_status:string;inviteBlocked?:string|null}>;requests:Array<{id:string;workforce_id:string;status:string;requested_at:string;error_message:string|null}>};
type DeskData=Omit<Partial<AmazonDaList>,'rows'>&Partial<InviteData>&{rows?:DeskPerson[];total?:number;facets?:Partial<Record<keyof Omit<DeskFilters,'query'>,FleetFilterOption[]>>;counts?:{information:number;address:number;all:number;unchecked:number};warnings?:string[];commandFacets?:{status:string[];action:string[]};commands?:AmazonDaCommand[];canApprove?:boolean;moreHistory?:boolean};
const tabs=[['onboarding','Onboarding',UserPlus],['associates','My associates',Users],['bgc-pending','BGC / IDfy',UserCheck],['offboarded','Offboarded',UserMinus],['invite','Invite',UserCheck],['approvals','Approvals',UserCheck],['history','History',History]] as const;
const human=(v:string|null|undefined)=>v?v.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/^\w/,c=>c.toUpperCase()):'';
const date=(v:string)=>new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});
async function api<T>(url:string,signal?:AbortSignal):Promise<T>{const res=await fetch(url,{cache:'no-store',signal});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load this view.');return data;}
export function Photo({person,station}:{person:AmazonDaPerson;station:string}){
 const [failed,setFailed]=useState(false);
 const src=person.photoUrl||(person.photoTicket?`/api/ops-pulse/amazon-da?${new URLSearchParams({view:'photo',station,profile:person.providerId,ticket:person.photoTicket})}`:null);
 useEffect(()=>setFailed(false),[src]);
 return <span className={styles.avatar}>{src&&!failed?<img src={src} alt="" width={52} height={52} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span>{person.name.trim().split(/\s+/).slice(0,2).map(n=>n[0]).join('')}</span>}</span>;
}
export function AmazonDaDesk({stations,canEdit,initialView='onboarding',initialStation,initialStations,notice,initialError,embedded=false,onStationChange}:{stations:Array<{id:string;code:string}>;canEdit:boolean;initialView?:string;initialStation?:string;initialStations?:string[];notice?:string;initialError?:string;embedded?:boolean;onStationChange?:(station:string)=>void}){
 const [station,setStation]=useState(stations.some(s=>s.id===initialStation)?initialStation!:stations[0]?.id||'');
 useEffect(()=>{onStationChange?.(station);},[station,onStationChange]);
 const [allScope,setAllScope]=useState(initialView==='approvals'||initialView==='history'),[historyPage,setHistoryPage]=useState(0);
 const [filters,setFilters]=useState<DeskFilters>(emptyDeskFilters);
 const [view,setView]=useState(initialView);const [query,setQuery]=useState('');const [debouncedQuery,setDebouncedQuery]=useState('');const [actionFilter,setActionFilter]=useState<string[]>([]);const [inviteStatus,setInviteStatus]=useState<string[]>([]);const [inviteEligibility,setInviteEligibility]=useState<string[]>([]);
 const [data,setData]=useState<DeskData>({});const [dataKey,setDataKey]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [expanded,setExpanded]=useState('');
 const [revision,setRevision]=useState(0);const [moreBusy,setMoreBusy]=useState(false);const requestSeq=useRef(0);const force=useRef(false);const cache=useRef(new Map<string,{data:DeskData;at:number}>());
 const pendingView=view.startsWith('bgc')||view==='auto';const isBgc=view.startsWith('bgc');const isList=['onboarding','associates','offboarded','bgc','bgc-pending','bgc-address'].includes(view);const auditView=['history','approvals'].includes(view);const requestStation=auditView&&allScope?'all':station;const key=`${requestStation}:${view}:${isList||auditView?debouncedQuery:''}:${actionFilter.join(',')}:${JSON.stringify(filters)}:${historyPage}`;const current=dataKey===key?data:{};const rows=current.rows||[];
 useEffect(()=>{const timer=setTimeout(()=>{setDebouncedQuery(query.trim());setHistoryPage(0);},300);return()=>clearTimeout(timer);},[query]);
 function resetFilters(){setExpanded('');setQuery('');setDebouncedQuery('');setActionFilter([]);setInviteStatus([]);setInviteEligibility([]);setFilters(emptyDeskFilters());setHistoryPage(0);}
 function changeFilter(key:keyof Omit<DeskFilters,'query'>,values:string[]){setExpanded('');setFilters(f=>({...f,[key]:values}));}
 function refresh(){cache.current.clear();force.current=true;setRevision(n=>n+1);}
 function listUrl(offset=0,snapshot=''){
  const p=new URLSearchParams({station:requestStation,view});if(auditView){p.set('filters','1');p.set('offset',String(historyPage*50));p.set('query',debouncedQuery);for(const v of filters.status)p.append('status',v);for(const v of actionFilter)p.append('action',v);}if(isList){p.set('filters','1');p.set('pageSize','24');p.set('offset',String(offset));p.set('query',debouncedQuery);for(const key of ['status','stage','milestone','address','check','health'] as const)for(const value of filters[key])p.append(key,value);if(snapshot)p.set('snapshot',snapshot);if(force.current)p.set('fresh','1');}return `/api/ops-pulse/amazon-da?${p}`;
 }
 useEffect(()=>{
  if(pendingView){setBusy(false);setError('');return;}if(!station)return;const seq=++requestSeq.current;const controller=new AbortController();setError('');setExpanded('');setMoreBusy(false);
  const saved=cache.current.get(key);if(saved&&!force.current&&Date.now()-saved.at<25_000){setData(saved.data);setDataKey(key);setBusy(false);return()=>{requestSeq.current++;};}
  setBusy(true);setData({});setDataKey(key);const url=listUrl();force.current=false;
  api<DeskData>(url,controller.signal).then(result=>{if(seq!==requestSeq.current)return;setData(result);if(cache.current.size>=8)cache.current.delete(cache.current.keys().next().value!);cache.current.set(key,{data:result,at:Date.now()});})
   .catch(e=>{if(seq===requestSeq.current&&e.name!=='AbortError')setError(e.message);}).finally(()=>{if(seq===requestSeq.current)setBusy(false);});
  return()=>{controller.abort();requestSeq.current++;};
 // The key includes every server filter; revision is explicit invalidation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,revision]);
 async function loadMore(){if(current.nextOffset==null||moreBusy)return;const seq=requestSeq.current;setMoreBusy(true);setError('');try{const next=await api<DeskData>(listUrl(current.nextOffset,current.snapshot));if(seq!==requestSeq.current)return;const merged=next.reset?next:{...next,rows:[...new Map([...rows,...(next.rows||[])].map(p=>[p.providerId,p])).values()]};setData(merged);cache.current.set(key,{data:merged,at:Date.now()});}catch(e){if(seq===requestSeq.current)setError((e as Error).message);}finally{if(seq===requestSeq.current)setMoreBusy(false);}}
 const filtered=rows;const invite=current.people||[];
 const inviteFacets=useMemo(()=>facetRows(invite,{status:{selected:inviteStatus,values:p=>p.onboarding_status},eligibility:{selected:inviteEligibility,values:p=>p.inviteBlocked?'Unavailable':p.email?'Email available':'Email missing'}},p=>query.toLowerCase().trim().split(/\s+/).every(t=>`${p.full_name} ${p.dropx_id||''} ${p.email||''}`.toLowerCase().includes(t))),[invite,inviteStatus,inviteEligibility,query]);
 return <section className={styles.desk} aria-busy={busy}>
  {notice?<p role="status" className={styles.next}>{notice}</p>:null}{initialError?<p role="alert" className={styles.error}>{initialError}</p>:null}
  <div className={styles.toolbar}>
   {!pendingView?<label className={styles.station}>Station<select value={auditView&&allScope?'all':station} onChange={e=>{setAllScope(e.target.value==='all');if(e.target.value!=='all')setStation(e.target.value);resetFilters();}} aria-label="Amazon station">{auditView?<option value="all">All my stations</option>:null}{stations.map(s=><option key={s.id} value={s.id}>{s.code}</option>)}</select></label>:null}
   {!embedded?<nav className={styles.tabs} aria-label="Amazon associates">{tabs.map(([id,label,Icon])=><button key={id} type="button" aria-pressed={view===id||(id==='bgc-pending'&&isBgc)} onClick={()=>{setView(id);setAllScope(id==='approvals'||id==='history');resetFilters();}}><Icon size={15} aria-hidden="true"/>{label}</button>)}</nav>:null}
   <button className={styles.refresh} type="button" onClick={refresh} disabled={busy||!station} aria-label="Refresh Amazon data" title="Refresh Amazon data"><RefreshCw size={16} className={busy?styles.spin:''}/><span>Refresh</span></button>
  </div>
  {!stations.length?<p className={styles.empty}>No Amazon stations are in your access.</p>:null}
  {error?<div role="alert" className={styles.error}>{error}<button onClick={refresh}>Retry</button></div>:null}
  {auditView?<><div className={styles.filters}><label className={styles.search}><Search size={16}/><input aria-label="Search action records" placeholder="Find a name or Amazon ID" value={query} onChange={e=>setQuery(e.target.value)}/></label><small>{current.total??'—'} records</small></div><div className={styles.filterBar}>
   <FleetMultiSelect label="Request status" allLabel="All request statuses" values={filters.status} options={(current.commandFacets?.status||filters.status).map(value=>({value,label:human(value)}))} onChange={values=>{changeFilter('status',values);setHistoryPage(0);}} alwaysSearch disabled={busy}/>
   <FleetMultiSelect label="Action" allLabel="All actions" values={actionFilter} options={(current.commandFacets?.action||actionFilter).map(value=>({value,label:human(value)}))} onChange={values=>{setActionFilter(values);setHistoryPage(0);}} alwaysSearch disabled={busy}/>
   <button onClick={resetFilters}>Reset filters</button></div></>:null}
  {pendingView?<BgcQueue stations={stations} initialStations={initialStations} canEdit={canEdit} revision={revision} onEmpty={view==='auto'?()=>setView('onboarding'):undefined}/>:isList?<>
   {isBgc?<nav className={styles.priorityTabs} aria-label="BGC priority queues">{[['bgc-pending','Insufficiencies',current.counts?.information],['bgc-address','Address verification pending',current.counts?.address],['bgc','All current IDs',current.counts?.all]].map(([id,label,count])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>{setView(String(id));setExpanded('');}}><span>{label}</span><strong>{busy?'…':count??'—'}</strong></button>)}</nav>:null}
   <div className={styles.filters}><label className={styles.search}><Search size={16}/><input aria-label="Search associates" placeholder="Find a name, Amazon ID, phone or email" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <span className={styles.resultCount}>{busy?'Loading…':`${filtered.length} of ${current.total??filtered.length} shown`}</span>{current.checkedAt?<span className={styles.updated}>Amazon updated {date(current.checkedAt)} IST</span>:null}
   </div>
   <div className={styles.filterBar}>
    {([['status','Amazon status','All statuses'],...(view==='onboarding'?[['stage','Current stage','All stages'],['milestone','Pending milestone','All pending steps'],['health','Progress','All progress']]:[]),['address','Address verification','All address checks'],['check','BGC status','All BGC checks']] as Array<[keyof Omit<DeskFilters,'query'>,string,string]>).map(([key,label,allLabel])=><FleetMultiSelect key={key} label={label} allLabel={allLabel} values={filters[key]} options={current.facets?.[key]||filters[key].map(value=>({value,label:value}))} onChange={values=>changeFilter(key,values)} alwaysSearch disabled={busy}/>)}
    <button type="button" onClick={()=>{setFilters(emptyDeskFilters());setQuery('');setDebouncedQuery('');setExpanded('');}}>Reset filters</button>
   </div>
   {isBgc?<p className={styles.meta}>Current Amazon IDs, including active associates. Counts follow search and filters. An ID can appear in both priority queues.{current.counts?.unchecked?` ${current.counts.unchecked} address checks are not available yet.`:''}</p>:null}
   {view==='onboarding'?<p className={styles.meta}>Pending steps use saved Amazon milestones. “Milestones not checked” means details are unavailable, not complete.</p>:null}
   {current.warnings?.map(w=><p role="status" className={styles.error} key={w}>{w}</p>)}
   {busy?<div className={styles.skeletonGrid} role="status" aria-label="Loading associates">{[0,1,2,3,4,5].map(n=><div key={n} className={styles.skeleton}><span/><div><i/><i/></div></div>)}</div>:null}
   {isBgc?<BulkBgc key={key} station={station} people={filtered}/>:null}
   <div className={styles.list}>{filtered.map(person=>{const open=expanded===person.providerId;const behind=/behind|blocked|error/i.test(person.health||'');return <article className={`${styles.card} ${open?styles.expanded:''}`} key={person.providerId}>
    <button className={styles.row} aria-expanded={open} aria-label={`View ${person.name}`} onClick={()=>setExpanded(open?'':person.providerId)}>
     <Photo person={person} station={station}/><span className={styles.identity}><strong>{person.name}</strong><small>{person.transporterId||'Amazon ID pending'}</small><span className={`${styles.badge} ${behind?styles.danger:person.status==='ACTIVE'||person.health==='ON_TRACK'?styles.good:person.status==='OFFBOARDED'?styles.muted:styles.warning}`}>{human(person.health||person.status)}</span></span><ChevronDown size={17} className={open?styles.chevronOpen:styles.chevron}/>
     {needsInformation(person)||addressPending(person)||person.bgc?.address?.state==='red'?<span className={styles.attentionBadges}>
      {needsInformation(person)?<span className={`${styles.badge} ${styles.danger}`}>Information needed{person.bgc?.checks.filter(c=>c.needsResponse).length?`: ${person.bgc.checks.filter(c=>c.needsResponse).map(c=>c.label).join(', ')}`:''}</span>:null}
      {addressPending(person)?<span className={`${styles.badge} ${styles.warning}`}>{person.bgc?.address?.label||'Address verification pending'}</span>:person.bgc?.address?.state==='red'?<span className={`${styles.badge} ${styles.danger}`}>Address verification · red</span>:null}
     </span>:null}
     {person.dropxLinkState&&person.dropxLinkState!=='linked'?<span className={styles.attentionBadges}><span className={`${styles.badge} ${styles.warning}`}>{person.dropxLinkState==='missing'?'DropX ID not linked':person.dropxLinkState==='review'?'DropX link needs review':'DropX link not checked'}</span></span>:null}
     {person.verificationWarning?<span className={styles.attentionBadges}><small>{person.verificationWarning}</small></span>:null}
     {!person.bgc?.address?<span className={styles.attentionBadges}><small>Address · not checked</small></span>:null}
     {isBgc?<span className={styles.stage}><span>{person.bgc?.status||'Status not synced yet'}</span><strong>{person.bgc?.reportAvailable?'Report available':''}</strong></span>:null}
     {!isBgc&&person.stage?<span className={styles.stage}><span>{human(person.stage)}</span>{person.progress!=null?<strong>{person.completedSteps}/{person.totalSteps} steps</strong>:null}</span>:null}
     {!isBgc&&person.progress!=null?<progress className={styles.progress} max="100" value={person.progress} aria-label={`${person.progress}% onboarding complete`}/>:null}
     {person.bgc?.checkedAt?<span className={styles.attentionBadges}><small>IDfy checked {date(person.bgc.checkedAt)} IST</small></span>:null}
     <span className={styles.cardAction}>{open?'Close details':needsInformation(person)?'Resolve insufficiency':addressPending(person)?'View pending verification':'View profile'}<ArrowRight size={13}/></span>
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
   <div className={styles.filterBar}><FleetMultiSelect label="Registration status" allLabel="All registration statuses" values={inviteStatus} options={inviteFacets.values('status').map(value=>({value,label:human(value)}))} onChange={setInviteStatus} alwaysSearch/><FleetMultiSelect label="Invitation availability" allLabel="All availability" values={inviteEligibility} options={inviteFacets.values('eligibility').map(value=>({value,label:value}))} onChange={setInviteEligibility} alwaysSearch/><button onClick={resetFilters}>Reset filters</button></div>
   {inviteFacets.rows.map(p=>{const latest=current.requests?.find(r=>r.workforce_id===p.id);return <div className={styles.inviteRow} key={p.id}><div><strong>{p.full_name}</strong><small>{p.dropx_id||'DropX ID pending'} · {p.email||'Email missing'}</small>{p.inviteBlocked?<small>{p.inviteBlocked}</small>:latest?<small className={latest.status==='failed'?styles.danger:''}>{human(latest.status)} · {date(latest.requested_at)} {latest.error_message||''}</small>:null}</div>
    <form action={queueAmazonInvitationFromOpsPulse}><input type="hidden" name="workforce_id" value={p.id}/><input type="hidden" name="amazon_desk_return" value="1"/><input type="hidden" name="amazon_desk_station" value={station}/><button disabled={!canEdit||!p.email||!!p.inviteBlocked||['sent','processing','pending','queued'].includes(latest?.status||'')} type="submit">{p.inviteBlocked?'Unavailable':latest?.status==='sent'?'Sent':latest?.status==='failed'?'Retry invite':'Send invite'}</button></form></div>;})}
   {!busy&&!inviteFacets.rows.length?<p className={styles.empty}>No registered associates at this station.</p>:null}
  </div>:busy?<p className={styles.meta}>Loading requests…</p>:<>{view==='approvals'?<Approvals commands={current.commands||[]} stations={stations} canApprove={!!current.canApprove} onChanged={refresh}/>:<Audit commands={current.commands||[]} station={station} canEdit={canEdit} onChecked={refresh}/>}<div className={styles.reviewButtons}>{historyPage>0?<button onClick={()=>setHistoryPage(n=>n-1)}>Previous</button>:null}{current.moreHistory?<button onClick={()=>setHistoryPage(n=>n+1)}>Next 50</button>:null}</div></>}
 </section>;
}
