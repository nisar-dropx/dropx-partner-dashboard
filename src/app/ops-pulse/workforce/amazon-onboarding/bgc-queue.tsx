'use client';
import {useEffect,useRef,useState} from 'react';
import {FleetMultiSelect} from '@/components/fleet-multi-select';
import type {AmazonDaPerson} from '@/lib/amazon-da-desk-types';
import {BgcPanel,type BgcResponse} from './bgc';
import {Photo} from './view';
import styles from './view.module.css';
type Row=AmazonDaPerson&{stationId:string;stationCode:string;requestData:BgcResponse};
export function BgcQueue({stations,canEdit,initialStations=[],revision=0,onEmpty,onAllProfiles}:{stations:Array<{id:string;code:string}>;canEdit:boolean;initialStations?:string[];revision?:number;onEmpty?:()=>void;onAllProfiles:()=>void}){
 const [rows,setRows]=useState<Row[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[selected,setSelected]=useState(initialStations),[checked,setChecked]=useState(''),[reload,setReload]=useState(0);
 const empty=useRef(onEmpty);empty.current=onEmpty;
 const scope=stations.map(s=>s.id).sort().join(',');
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');
  fetch('/api/ops-pulse/amazon-da?view=bgc-pending&station=all'+(revision||reload?'&fresh=1':''),{cache:'no-store',signal:controller.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Could not check IDfy requests.');return d;}).then(d=>{if(controller.signal.aborted)return;setRows(d.rows);setChecked(d.checkedAt);if(!d.rows.length)empty.current?.();}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
 },[scope,revision,reload]);
 const search=(p:Row)=>`${p.name} ${p.transporterId||''} ${p.email||''} ${p.phone||''} ${p.stationCode}`.toLowerCase().includes(query.trim().toLowerCase());
 const options=stations.filter(s=>selected.includes(s.id)||rows.some(p=>p.stationId===s.id&&search(p))).map(s=>({value:s.id,label:s.code}));
 const visible=rows.filter(p=>(!selected.length||selected.includes(p.stationId))&&search(p)).sort((a,b)=>a.stationCode.localeCompare(b.stationCode)||a.name.localeCompare(b.name));
 return <section className={styles.pendingQueue} aria-label="IDfy requests" aria-busy={busy}>
  <div className={styles.split}><strong>IDfy needs information {busy?'':`· ${rows.length}`}</strong><button onClick={onAllProfiles}>All BGC profiles</button></div>
  <div className={styles.queueFilters}><FleetMultiSelect label="Station" allLabel="All my Amazon stations" options={options} values={selected} onChange={setSelected} alwaysSearch/><input aria-label="Search IDfy requests" placeholder="Search name, ID, phone or station" value={query} onChange={e=>setQuery(e.target.value)}/>{selected.length||query?<button onClick={()=>{setSelected([]);setQuery('');}}>Reset</button>:null}<small>{busy?'Checking IDfy…':`${visible.length} pending profiles`}{checked?` · ${new Date(checked).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST`:''}</small></div>
  {error?<div className={styles.error} role="alert">{error}<button onClick={()=>setReload(n=>n+1)}>Retry</button></div>:null}
  {busy&&!rows.length?<div className={styles.skeleton} role="status">Checking current requests across your Amazon stations…</div>:null}
  {visible.map(p=><article key={p.providerId} className={styles.requestCard}><header><Photo person={p} station={p.stationId}/><div><strong>{p.name}</strong><small>{p.stationCode} · {p.transporterId||'Amazon ID pending'}</small></div><span className={`${styles.badge} ${styles.warning}`}>Information needed</span></header><BgcPanel station={p.stationId} providerId={p.providerId} initial={p.bgc} initialData={p.requestData} canEdit={canEdit&&!busy} onResolved={()=>setReload(n=>n+1)}/></article>)}
  {!busy&&!error&&!visible.length?<div className={styles.empty}><strong>{rows.length?'No requests match these filters':'No pending IDfy requests'}</strong>{rows.length?<button onClick={()=>{setSelected([]);setQuery('');}}>Clear filters</button>:null}</div>:null}
 </section>;
}
