'use client';
import {useState} from 'react';
export function CodMailboxCheck(){
 const [busy,setBusy]=useState(false),[result,setResult]=useState<{connected:boolean;message:string}|null>(null);
 async function check(){setBusy(true);try{const response=await fetch('/api/ops-pulse/cod/mailbox-status',{cache:'no-store'});const body=await response.json();setResult({connected:body.connected===true,message:body.message||body.error||'Connection check unavailable.'});}catch{setResult({connected:false,message:'Connection check unavailable. Please retry.'});}finally{setBusy(false);}}
 return <div><button className="button secondary" type="button" disabled={busy} onClick={check}>{busy?'Checking connection…':'Check Control Tower email'}</button>{result?<p role="status" style={{maxWidth:420,whiteSpace:'normal',color:result.connected?'#166534':'#b91c1c'}}>{result.message}</p>:null}</div>;
}
