'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Search,RefreshCw,Plus,ChevronDown,ArrowUpRight} from 'lucide-react';
import {setupMilestones} from '@/lib/da-onboarding-setup';
import {daNeedsAttention,type DARow} from '@/lib/da-onboarding-registry';
import {Profile} from '@/app/ops-pulse/workforce/amazon-onboarding/profile';
import {BgcPanel} from '@/app/ops-pulse/workforce/amazon-onboarding/bgc';
import {FleetMultiSelect} from './fleet-multi-select';
import {filterDA,daFacets,daStage,type ScopedDA} from '@/lib/da-onboarding-view';
import {BulkBgc} from '@/app/ops-pulse/workforce/amazon-onboarding/bulk-bgc';
import {AmazonDaDesk,Photo} from '@/app/ops-pulse/workforce/amazon-onboarding/view';
import {workforceStage,workforceAction,workforceNeedsAction,workforceQueues,inWorkforceQueue,type WorkforceQueue} from '@/lib/da-onboarding-policy';
import {DAInviteForm} from './da-invite-form';
import {DAOnboardingRecord} from './da-onboarding-record';
import styles from './da-onboarding-desk.module.css';
type Station={id:string;code:string;provider:string;supported:boolean};
type Result={rows:ScopedDA[];warnings:string[];checkedAt:string|null};

const human=(s:string|null|undefined)=>(s==='ID_NOT_LINKED'?'ID not linked':s||'Awaiting confirmation').replaceAll('_',' ').replace(/([a-z])([A-Z][a-z])/g,'$1 $2');
const stamp=(s:string)=>new Date(s).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
export function DAOnboardingDesk({stations,initialStation,initialStations,initialView,canEdit,canAdd,canAmazon,canManage=false,onAmazon}:{stations:Station[];initialStation?:string;initialStations?:string[];initialView?:string;canEdit:boolean;canAdd:boolean;canAmazon:boolean;canManage?:boolean;onAmazon?:(stationIds:string[])=>void}){
 const initial=stations.some(s=>s.id===initialStation)?initialStation!:stations.find(s=>s.supported)?.id||stations[0]?.id||'';
 const router=useRouter();
 const openBgc=()=>router.push('/workforce/onboarding?'+new URLSearchParams({tab:'amazon',view:'bgc-pending',stations:scoped.map(s=>s.id).join(',')}));
 const [stationIds,setStationIds]=useState<string[]>(initialStations?.some(id=>stations.some(s=>s.id===id&&s.supported))?initialStations.filter(id=>stations.some(s=>s.id===id&&s.supported)):initial?[initial]:[]),[statuses,setStatuses]=useState<string[]>([]),[origins,setOrigins]=useState<string[]>([]),[verification,setVerification]=useState<string[]>(initialView==='bgc-pending'?['details_needed']:[]),[attentionOnly,setAttentionOnly]=useState(false),[sort,setSort]=useState('name'),[exporting,setExporting]=useState('');
 const scoped=stations.filter(s=>s.supported&&(!stationIds.length||stationIds.includes(s.id))),station=scoped[0]?.id||initial;
 const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const [query,setQuery]=useState(''),[expanded,setExpanded]=useState(''),[page,setPage]=useState(1);
 const [tool,setTool]=useState(['invite','approvals','history'].includes(initialView||'')?initialView!:'');
 const cache=useRef(new Map<string,{data:Result;at:number}>());const selected=stations.find(s=>s.id===station);
 const [queue,setQueue]=useState<WorkforceQueue>(initialView==='offboarded'?'offboarded':initialView==='associates'?'active':'attention');
 const [inviting,setInviting]=useState(false);
 const archive=queue==='offboarded';const scopeKey=scoped.map(s=>s.id).sort().join(',');
 function refresh(){cache.current.clear();setRevision(x=>x+1);}
 useEffect(()=>{const controller=new AbortController();setError('');setResult({rows:[],warnings:[],checkedAt:null});setExpanded('');setPage(1);setBusy(!!scopeKey);
 const timer=setTimeout(()=>{void(async()=>{const ids=scopeKey.split(',').filter(Boolean);let cursor=0;const results=new Map<string,Result>();
 const publish=()=>{if(controller.signal.aborted)return;const all=[...results.values()];setResult({rows:all.flatMap(r=>r.rows),warnings:all.flatMap(r=>r.warnings),checkedAt:all.map(r=>r.checkedAt).filter((v):v is string=>!!v).sort()[0]||null});};
 const run=async()=>{while(cursor<ids.length&&!controller.signal.aborted){const id=ids[cursor++],code=stations.find(s=>s.id===id)?.code||id,key=id+':'+archive;try{const saved=cache.current.get(key);let data:Result;if(saved&&Date.now()-saved.at<60000)data=saved.data;else{const response=await fetch('/api/ops-pulse/da-onboarding?'+new URLSearchParams({station:id,archive:archive?'1':'0'}),{signal:controller.signal,cache:'no-store'});const raw=await response.json();if(!response.ok)throw Error(raw.error||'Unable to load');data={...raw,rows:raw.rows.map((r:DARow)=>({...r,key:id+':'+r.key,stationId:id,stationCode:code})),warnings:raw.warnings.map((w:string)=>code+': '+w)};if(!controller.signal.aborted)cache.current.set(key,{data,at:Date.now()});}results.set(id,data);}catch(e){if(controller.signal.aborted)return;results.set(id,{rows:[],warnings:[code+': source unavailable. Refresh to retry.'],checkedAt:null});}publish();}};
 await Promise.all([run(),run()]);if(!controller.signal.aborted)setBusy(false);})();},250);return()=>{clearTimeout(timer);controller.abort();};
 },[scopeKey,archive,revision]);
 const allRows=useMemo(()=>result?.rows||[],[result]);
 const rows=useMemo(()=>allRows.filter(r=>inWorkforceQueue(r,queue)),[allRows,queue]);
 const facets=useMemo(()=>daFacets(rows,{query,statuses,origins,verification,attention:attentionOnly,workforce:true}),[rows,query,statuses,origins,verification,attentionOnly]);
 const bgcCount=allRows.filter(r=>r.amazon?.bgc?.checks.some(c=>c.needsResponse)).length;
 const filtered=useMemo(()=>filterDA(rows,{query,statuses,origins,verification,attention:attentionOnly,workforce:true}).sort((a,b)=>sort==='station'?a.stationCode.localeCompare(b.stationCode)||a.name.localeCompare(b.name):sort==='status'?workforceStage(a).localeCompare(workforceStage(b))||a.name.localeCompare(b.name):a.name.localeCompare(b.name)),[rows,query,statuses,origins,verification,attentionOnly,sort]);
 const countRows=useMemo(()=>filterDA(allRows,{query,statuses:[],origins,verification,attention:false,workforce:true}),[allRows,query,origins,verification]);
 const shown=filtered.slice((page-1)*25,page*25);
 function selectFilter(set:(v:string[])=>void,values:string[]){set(values);setPage(1);setExpanded('');}
 function reset(){setQuery('');setStatuses([]);setOrigins([]);setVerification([]);setAttentionOnly(false);setSort('name');setPage(1);}
 async function exportRows(format:'xlsx'|'pdf'){setExporting(format);setError('');try{const {exportDA}=await import('@/lib/da-onboarding-export');await exportDA(filtered,format,'View: '+(archive?'Offboarded':'Current')+' | Stations: '+scoped.map(s=>s.code).join(', ')+' | Status: '+(statuses.join(', ')||'Current')+' | Verification: '+(verification.join(', ')||'All')+' | Source: '+(origins.join(', ')||'All')+' | Search: '+(query||'None'));}catch(e){setError((e as Error).message||'Export failed. Please retry.');}finally{setExporting('');}}
 return <div className={styles.desk}>
  <header className={styles.heading}><div><small>WORKFORCE</small><h1>Workforce onboarding</h1><p>Invite associates, clear pending actions and track their DropX status.</p></div><div className={styles.headerActions}>{canAmazon?<select aria-label="Onboarding tools" value={tool} onChange={e=>{if(e.target.value==='bgc-pending'){openBgc();}else setTool(e.target.value);}}><option value="">More actions</option><option value="invite">Invite existing registration</option><option value="bgc-pending">BGC needs information ({bgcCount})</option><option value="approvals">Approval requests</option><option value="history">Action history</option></select>:null}{onAmazon?<button onClick={()=>onAmazon(scoped.map(s=>s.id))}>Amazon status ↗</button>:null}{canAdd&&selected?.supported&&scoped.length===1?<button className={styles.primary} onClick={()=>setInviting(true)}><Plus size={16}/>Invite associate</button>:null}</div></header>
  {inviting&&scoped.length===1?<DAInviteForm key={station} stationId={station} stationCode={selected?.code||''} onClose={()=>setInviting(false)} onCreated={()=>{setQueue('onboarding');refresh();}}/>:null}
  {!tool?<section className={styles.toolbar}><div className={styles.multi}><FleetMultiSelect label="Location scope" allLabel="All my Amazon stations" values={stationIds} options={stations.filter(s=>s.supported).map(s=>({value:s.id,label:s.code,helper:s.provider}))} onChange={v=>selectFilter(setStationIds,v)} alwaysSearch/></div><label className={styles.search}><Search size={16}/><input aria-label="Search associates" maxLength={200} placeholder="Search name, DropX ID, mobile or station" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/></label><button onClick={refresh} disabled={busy}><RefreshCw size={15} className={busy?styles.spin:''}/>{busy?'Syncing…':'Refresh'}</button></section>:null}
  {tool&&canAmazon?<section className={styles.tools}><div><strong>{tool==='invite'?'Existing registrations':tool==='approvals'?'Approval requests':tool.startsWith('bgc')?'BGC / IDfy follow-up':'Action history'}</strong><button onClick={()=>setTool('')}>Back to all associates</button></div><AmazonDaDesk key={`${station}:${tool}`} stations={stations.filter(s=>s.supported)} initialStation={station} initialView={tool} canEdit={canEdit} embedded/></section>:<>
  <nav className={styles.queueTabs} aria-label="Workforce status">{workforceQueues.map(q=><button key={q.id} aria-current={queue===q.id?'page':undefined} onClick={()=>{setQueue(q.id);setStatuses([]);setPage(1);setExpanded('');}}>{q.label}{q.id!=='offboarded'||archive?<strong>{countRows.filter(r=>inWorkforceQueue(r,q.id)).length}{busy||result?.warnings.length?'*':''}</strong>:null}</button>)}</nav>
  <p className={styles.queueHint}>{queue==='attention'?'DropX associates with incomplete setup or follow-ups. Open a record to see the next action.':queue==='onboarding'?'Associates whose DropX registration or activation is still pending.':queue==='active'?'Active DropX IDs. Pending payment setup remains visible in Needs action.':queue==='inactive'?'Inactive associates retained for review or rejoining.':'Offboarded DropX associates and their saved records.'}{busy?' Loading selected stations…':''}</p>
  {error?<div role="alert" className={styles.warning}>{error}<button onClick={refresh}>Retry</button></div>:null}
  {result?.warnings.map(w=><div key={w} role="status" className={styles.warning}>{w}</div>)}
  {!scoped.length?<div className={styles.empty}>Onboarding for this provider is not connected yet. Existing profiles remain in <Link href="/work-force-register">Workforce Register</Link>.</div>:<section className={styles.register} aria-busy={busy}>
   <div className={styles.filters}>
    <div className={styles.multi}><FleetMultiSelect label="Status" allLabel="All statuses" values={statuses} options={facets.options('statuses',['ACTIVE','ONBOARDING','INACTIVE','OFFBOARDED'].map(value=>({value,label:human(value)})))} onChange={v=>selectFilter(setStatuses,v)} alwaysSearch/></div>
    <div className={styles.multi}><FleetMultiSelect label="Pending step" allLabel="All setup steps" values={verification} options={facets.options('verification',[['registration','Registration'],['dropx_id','DropX ID creation'],['activation','DropX activation'],['mapping','ID mapping'],['rate_card','Rate card'],['details_needed','BGC needs information'],['candidate_pending','Address · candidate pending'],['information_needed','Address · information needed'],['review','Address · in progress'],['red','Address · red'],['verified','Address · verified'],['unknown','Not checked'],['not_requested','Address · not requested']].map(([value,label])=>({value,label})))} onChange={v=>selectFilter(setVerification,v)} alwaysSearch/></div>
    <div className={styles.multi}><FleetMultiSelect label="Account source" allLabel="All sources" values={origins} options={facets.options('origins',['System invitation','Existing DropX profile'].map(value=>({value,label:value})))} onChange={v=>selectFilter(setOrigins,v)} alwaysSearch/></div>
    <select aria-label="Sort associates" value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="name">Name A–Z</option><option value="station">Station</option><option value="status">Status</option></select><button onClick={reset}>Reset</button><button disabled={busy||!!exporting||!filtered.length||!!result?.warnings.length} onClick={()=>void exportRows('xlsx')}>{exporting==='xlsx'?'Preparing…':'Excel'}</button><button disabled={busy||!!exporting||!filtered.length||!!result?.warnings.length} onClick={()=>void exportRows('pdf')}>{exporting==='pdf'?'Preparing…':'PDF'}</button>
   </div>{result?.warnings.length?<small className={styles.exportNote}>Exports are available when every selected source has loaded. Refresh to retry.</small>:null}
   {canAmazon&&verification.some(v=>['details_needed','candidate_pending','information_needed','review','red'].includes(v))?<BulkBgc key={scopeKey+verification.join(',')+query} station={station} people={filtered.flatMap(r=>r.amazon?[{...r.amazon,stationId:r.stationId}]:[])}/>:null}
   <div className={styles.cards}>
   {busy&&!rows.length?<div className={styles.loading} role="status">{[0,1,2].map(i=><div key={i} className={styles.skeleton}/>)}<span>Loading workforce records…</span></div>:shown.map(row=>{const open=expanded===row.key,attention=workforceNeedsAction(row),active=workforceStage(row)==='active';return <article key={row.key} className={`${styles.card} ${open?styles.selected:''}`}>
    <button className={styles.cardSummary} aria-label={`View ${row.name}`} aria-expanded={open} onClick={()=>setExpanded(open?'':row.key)}>
     <span className={styles.person}><span className={styles.avatar}>{row.name.trim().split(/\s+/).slice(0,2).map(n=>n[0]).join('')}</span><span><strong>{row.name}</strong><small className={styles.dropxCode}>{row.owner?.dropx_id||'Invited · DropX ID pending'}</small><em>{row.stationCode} · {row.owner?.designation||'Delivery associate'}</em></span></span>
     <span className={styles.owner}><small>SETUP CHECKS</small><strong>{setupMilestones(row).filter(m=>m.state==='complete').length} / {setupMilestones(row).length} confirmed</strong><span>{row.origin}</span></span>
     <span className={styles.status}><span className={`${styles.badge} ${active?styles.active:''}`}>{human(workforceStage(row))}</span><strong className={attention?styles.attention:undefined}>{workforceAction(row)}</strong></span>
     <span className={styles.expand}>{open?'Close':row.amazon?.bgc?.checks.some(c=>c.needsResponse)?'Resolve BGC':attention?'Review':active?'Details':'Continue'}<ChevronDown size={16}/></span>
    </button>
    {open?<div className={styles.detail}>
    <section className={styles.journey} aria-label="DropX setup milestones">{setupMilestones(row).map((m,i)=><div key={m.id} className={styles.milestone} data-state={m.state}><span className={styles.stepDot}>{m.state==='complete'?'✓':i+1}</span><div><strong>{m.label}</strong><span>{m.detail}</span></div><small>{m.state==='complete'?'Confirmed':m.state==='review'?'Review':m.state==='unknown'?'Not checked':'Pending'}</small></div>)}</section>
    <div className={styles.record}><div><small>Contact</small><strong>{row.phone||'Not provided'}</strong><span>{row.email||'Email not provided'}</span></div><div><small>Record source</small><strong>{row.origin}</strong><span>{row.setup?.checkedAt?`Setup checked ${stamp(row.setup.checkedAt)} IST`:''}</span></div></div>
   <div className={styles.recordActions}><Link href={`/provider-id-mapping?mapping=all&q=${encodeURIComponent(row.owner?.dropx_id||row.name)}`}>ID mapping & rate card<ArrowUpRight size={14}/></Link>{row.owner?<Link href={`/work-force-register?section=register&ids=${encodeURIComponent(row.owner.id)}`}>DropX profile<ArrowUpRight size={14}/></Link>:null}</div>
   {row.guided||row.owner?<DAOnboardingRecord id={row.guided?.id||row.owner!.id} stationId={row.stationId} managed={!!row.guided} canEdit={canManage}/>:null}
   {row.linkedAmazon?.length&&canAmazon?<details className={styles.mailbox}><summary>Linked Amazon accounts · {row.linkedAmazon.length}</summary>{row.linkedAmazon.map(a=><div key={a.providerId}><Profile station={row.stationId} providerId={a.providerId} initialPerson={a} canEdit={canEdit} onChanged={refresh}/></div>)}</details>:null}</div>:null}
   </article>;})}
   {!busy&&!error&&!shown.length?<div className={styles.empty}>No associates match these filters.</div>:null}
   </div><footer><span>{filtered.length} associates{result?.checkedAt?` · Source checked ${stamp(result.checkedAt)} IST`:''}</span><div><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{page} / {Math.max(1,Math.ceil(filtered.length/25))}</span><button disabled={page*25>=filtered.length} onClick={()=>setPage(p=>p+1)}>Next</button></div></footer>
  </section>}
  </>}
 </div>;
}
