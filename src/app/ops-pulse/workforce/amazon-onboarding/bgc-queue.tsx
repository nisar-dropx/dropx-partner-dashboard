'use client';
import {useEffect,useRef,useState} from 'react';
import {FleetMultiSelect,type FleetFilterOption} from '@/components/fleet-multi-select';
import {emptyDeskFilters,needsInformation,addressPending,filterDeskPage,completeRequestInbox,type DeskFilters,type DeskPerson} from '@/lib/amazon-da-filters';
import {BgcPanel,type BgcResponse} from './bgc';
import {Photo} from './view';
import styles from './view.module.css';
type Row=DeskPerson&{stationId:string;stationCode:string};
type Data={rows:Row[];counts:{information:number;address:number|null;all:number|null;unchecked:number};facets:Record<keyof Omit<DeskFilters,'query'>,FleetFilterOption[]>;requestOnly?:boolean;total:number;nextOffset:number|null;snapshot:string;reset?:boolean;incomplete?:boolean;checkedAt:string;warnings:string[]};
export function BgcQueue({stations,canEdit,initialStations=[],revision=0,onEmpty,onAllProfiles}:{stations:Array<{id:string;code:string}>;canEdit:boolean;initialStations?:string[];revision?:number;onEmpty?:()=>void;onAllProfiles?:()=>void}){
 const [data,setData]=useState<Data|null>(null),[busy,setBusy]=useState(true),[moreBusy,setMoreBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[reload,setReload]=useState(0),[view,setView]=useState('bgc-pending'),[expanded,setExpanded]=useState('');
 const [filters,setFilters]=useState<DeskFilters>(()=>({...emptyDeskFilters(),station:initialStations}));
 const empty=useRef(onEmpty);empty.current=onEmpty;const seq=useRef(0);const fresh=useRef(false);const lastRevision=useRef(revision);
 const scope=stations.map(s=>s.id).sort().join(',');const key=JSON.stringify([scope,view,search,filters,revision,reload]);
 const inbox=useRef<{key:string;data:Data}|null>(null);const sourceKey=JSON.stringify([scope,revision,reload]);
 useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),300);return()=>clearTimeout(timer);},[query]);
 function url(offset=0,snapshot=''){const p=new URLSearchParams({view,station:'all',filters:'1',query:search,offset:String(offset),snapshot});for(const k of ['status','address','check','station'] as const)for(const v of filters[k])p.append(k==='station'?'location':k,v);if(fresh.current){p.set('fresh','1');fresh.current=false;}return '/api/ops-pulse/amazon-da?'+p;}
 useEffect(()=>{const request=++seq.current,controller=new AbortController();if(lastRevision.current!==revision){fresh.current=true;lastRevision.current=revision;}setError('');setExpanded('');
  if(inbox.current?.key!==sourceKey)inbox.current=null;
  const saved=inbox.current?.data;
  if(view==='bgc-pending'&&saved&&!fresh.current){const page=filterDeskPage(saved.rows,{...filters,query:search},view,0,saved.snapshot,'');setData({...saved,...page,rows:page.rows as Row[],facets:page.facets as Data['facets'],counts:{...page.counts,address:null,all:null,unchecked:0}});setBusy(false);return()=>controller.abort();}
  setBusy(true);setData(null);
  fetch(url(),{cache:'no-store',signal:controller.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Could not check IDfy requests.');return d as Data;}).then(d=>{if(request!==seq.current||controller.signal.aborted)return;if(view==='bgc-pending'&&completeRequestInbox(d,{...filters,query:search}))inbox.current={key:sourceKey,data:d};setData(d);if(!d.incomplete&&!d.warnings.length&&!search&&!filters.station.length&&!filters.status.length&&!filters.address.length&&!filters.check.length&&d.counts.information===0&&(d.requestOnly||d.counts.address===0))empty.current?.();}).catch(e=>{if(request===seq.current&&e.name!=='AbortError')setError(e.message);}).finally(()=>{if(request===seq.current&&!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
 // Each dependency is included in the stable request key.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key]);
 function refresh(){fresh.current=true;setReload(n=>n+1);}
 function reset(){setFilters(emptyDeskFilters());setQuery('');setSearch('');}
 async function more(){if(!data||data.nextOffset==null||moreBusy)return;const request=seq.current;setMoreBusy(true);try{const r=await fetch(url(data.nextOffset,data.snapshot),{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);if(request!==seq.current)return;setData(d.reset?d:{...d,rows:[...new Map([...data.rows,...d.rows].map(p=>[p.stationId+':'+p.providerId,p])).values()]});}catch(e){if(request===seq.current)setError((e as Error).message);}finally{setMoreBusy(false);}}
 const counts=data?.counts;
 return <section className={styles.pendingQueue} aria-label="IDfy requests" aria-busy={busy}>
  <nav className={styles.priorityTabs} aria-label="BGC priority queues">{[['bgc-pending','Insufficiencies',counts?.information],['bgc-address','Address verification pending',counts?.address],['bgc','All current IDs',counts?.all]].map(([id,label,count])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>setView(String(id))}><span>{label}</span><strong>{busy?'…':count??'Open'}{data?.incomplete?'*':''}</strong></button>)}</nav>
  <div className={styles.filters}><label className={styles.search}><input aria-label="Search IDfy requests" placeholder="Search name, ID, phone or station" value={query} onChange={e=>setQuery(e.target.value)}/></label><small>{busy?'Checking saved IDfy records…':`${data?.total??'—'} matching IDs`}{data?.checkedAt?` · Amazon checked ${new Date(data.checkedAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST`:''}</small></div>
  <div className={styles.filterBar}>{([['station','Station','All my Amazon stations'],['status','Amazon status','All statuses'],['address','Address verification','All address checks'],['check','BGC status','All BGC checks']] as const).map(([k,label,allLabel])=><FleetMultiSelect key={k} label={label} allLabel={allLabel} options={[...(data?.facets[k]||[]),...filters[k].filter(value=>!data?.facets[k]?.some(o=>o.value===value)).map(value=>({value,label:value}))].map(option=>k==='station'?{...option,label:stations.find(s=>s.id===option.value)?.code||option.label}:option)} values={filters[k]} onChange={values=>setFilters(f=>({...f,[k]:values}))} alwaysSearch disabled={busy}/>)}<button onClick={reset}>Reset filters</button></div>
  <p className={styles.meta}>{data?.requestOnly?'Current IDfy requests · counts follow your filters.':'Counts follow search and filters. An ID can need both information and address verification.'}{counts?.unchecked?` ${counts.unchecked} address checks are not available yet.`:''}{data?.incomplete?' * Some stations could not be checked; totals are incomplete.':''}</p>
  {data?.warnings.map(w=><p role="status" className={styles.error} key={w}>{w}</p>)}
  {error?<div className={styles.error} role="alert">{error}<button onClick={refresh}>Retry</button></div>:null}
  {busy?<div className={styles.skeleton} role="status">Checking current IDs across your Amazon stations…</div>:null}
  {data?.rows.map(p=>{const id=p.stationId+':'+p.providerId,open=expanded===id||view==='bgc-pending';return <article key={id} className={styles.requestCard}><header><Photo person={p} station={p.stationId}/><div><strong>{p.name}</strong><small>{p.stationCode} · {p.transporterId||'Amazon ID pending'} · {p.status}</small>{p.bgc?.checkedAt?<small>IDfy checked {new Date(p.bgc.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} IST</small>:null}</div>{needsInformation(p)?<span className={`${styles.badge} ${styles.danger}`}>Information needed</span>:null}{addressPending(p)?<span className={`${styles.badge} ${styles.warning}`}>{p.bgc?.address?.label||'Address pending'}</span>:null}{view!=='bgc-pending'?<button aria-expanded={open} onClick={()=>setExpanded(open?'':id)}>{open?'Close':'View details'}</button>:null}</header>{p.verificationWarning?<p className={styles.meta}>{p.verificationWarning}</p>:null}{open?<BgcPanel station={p.stationId} providerId={p.providerId} initial={p.bgc} initialData={p.requestData as BgcResponse|undefined} canEdit={canEdit&&!busy} onResolved={refresh}/>:null}</article>})}
  {data?.reset?<p role="status" className={styles.meta}>Source records changed. Showing the latest first page.</p>:null}
  {data?.nextOffset!=null?<button className={styles.loadMore} onClick={()=>void more()} disabled={moreBusy}>{moreBusy?'Loading…':'Load more'}</button>:null}
  {!busy&&!error&&!data?.rows.length?<div className={styles.empty}><strong>{data?.incomplete?'No matches in the stations checked':'No IDs match this queue and filters'}</strong><button onClick={reset}>Clear filters</button></div>:null}
 </section>;
}
