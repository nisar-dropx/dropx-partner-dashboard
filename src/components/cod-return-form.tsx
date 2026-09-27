'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useCodFormState} from '@/app/ops-pulse/cod/submission/use-cod-form-state';
import {returnCodSlip} from '@/app/ops-pulse/cod/pending/actions';
export function CodReturnForm({id,version}:{id:string;version:number}){
 const router=useRouter();const [pending,setPending]=useState(false);
 const [state,action]=useCodFormState(returnCodSlip,{ok:false,message:''});
 async function submit(form:FormData){if(pending)return;setPending(true);try{await action(form);router.refresh();}finally{setPending(false);}}
 return <details style={{marginTop:12}}><summary style={{cursor:'pointer',color:'#b91c1c',fontWeight:700}}>Return for re-upload</summary><form action={submit} style={{display:'grid',gap:8,marginTop:10}}><input type="hidden" name="submission_id" value={id}/><input type="hidden" name="proof_version" value={version}/><label>Reason<textarea className="field" name="reason" required minLength={3} maxLength={300} rows={2} placeholder="e.g. Wrong receipt uploaded. Please replace it."/></label><p className="subtle">Notifies the station and cluster manager in this station’s ongoing correction email.</p>{!state.ok?<button className="button primary" disabled={pending}>{pending?'Returning…':'Return slip'}</button>:null}{state.message?<p role="status" style={{color:state.ok?'#166534':'#b91c1c'}}>{state.message}</p>:null}</form></details>;
}
