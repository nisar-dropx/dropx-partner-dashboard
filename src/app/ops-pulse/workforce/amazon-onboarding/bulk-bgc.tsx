'use client';
import {useState} from 'react';
import type {AmazonDaPerson} from '@/lib/amazon-da-desk-types';
import styles from './view.module.css';
export function BulkBgc({station,people}:{station:string;people:(AmazonDaPerson&{stationId?:string})[]}){
 const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function download(){
  setBusy(true);setMessage('Preparing reports…');
  try{
   const {default:JSZip}=await import('jszip'),zip=new JSZip(),notes:string[]=[];let count=0,bytes=0;
   for(const [index,id] of selected.entries()){
    const person=people.find(p=>p.providerId===id);if(!person)continue;
    setMessage(`Preparing ${index+1} of ${selected.length}…`);
    try{const response=await fetch(`/api/ops-pulse/amazon-da?${new URLSearchParams({view:'idfy-report',station:person.stationId||station,profile:id,download:'1'})}`);
     if(!response.ok)throw Error('Report unavailable');const blob=await response.blob();bytes+=blob.size;
     if(bytes>60*1024*1024)throw Error('Download size limit reached; download this report individually');
     zip.file(`${(person.transporterId||id).replace(/[^a-z0-9-]/gi,'_')}.pdf`,blob);count++;
    }catch(e){notes.push(`${person.name}: ${(e as Error).message}`);}
   }
   if(notes.length)zip.file('Unavailable reports.txt',notes.join('\n'));
   if(count||notes.length){const blob=await zip.generateAsync({type:'blob',compression:'STORE'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='BGC-reports.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
   setMessage(`${count} reports downloaded${notes.length?` · ${notes.length} unavailable (listed in download)`:''}.`);
  }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}
 }
 const available=people.filter(p=>p.bgc?.reportAvailable);
 return <details className={styles.bulkBgc}><summary>Download BGC reports <small>Select up to 10</small></summary><div className={styles.reportChoices}>{available.map(p=><label key={p.providerId}><input type="checkbox" checked={selected.includes(p.providerId)} disabled={busy||(!selected.includes(p.providerId)&&selected.length>=10)} onChange={e=>setSelected(v=>e.target.checked?[...v,p.providerId]:v.filter(id=>id!==p.providerId))}/>{p.name}</label>)}</div>{!available.length?<small>No published reports in the loaded profiles. Open an associate to check the latest status.</small>:<button disabled={busy||!selected.length} onClick={()=>void download()}>{busy?'Preparing…':`Download selected (${selected.length})`}</button>}{message?<p role="status">{message}</p>:null}</details>;
}
