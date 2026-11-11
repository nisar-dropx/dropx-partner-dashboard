'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useCodFormState} from '@/app/ops-pulse/cod/submission/use-cod-form-state';
import {allocateCodRecovery} from '@/app/ops-pulse/cod/pending/actions';
export function CodRecoveryForm({id,items}:{id:string;items:Array<{id:string;deposit_date:string;remittance_code:string;remaining_amount:number}>}){
 const router=useRouter(),[pending,setPending]=useState(false);
 const [state,action]=useCodFormState(allocateCodRecovery,{ok:false,message:''});
 async function submit(form:FormData){if(pending)return;setPending(true);try{await action(form);router.refresh();}finally{setPending(false);}}
 return <details style={{marginTop:12}}><summary>Record shortage recovery</summary><form action={submit} style={{display:'grid',gap:8,maxWidth:520,marginTop:10}}>
 <input type="hidden" name="submission_id" value={id}/>
 <label>Original short deposit<select name="ledger_id" className="field" required>{items.map(r=><option key={r.id} value={r.id}>{r.deposit_date} · {r.remittance_code} · ₹{Number(r.remaining_amount).toLocaleString('en-IN')} remaining</option>)}</select></label>
 <label>Amount recovered from this receipt<input className="field" name="amount" type="number" step="0.01" min="0.01" required/></label>
 <label>Recovery note<textarea className="field" name="note" minLength={8} maxLength={300} required rows={2}/></label>
 <label><input type="checkbox" name="confirmed" value="yes" required/> This reviewed receipt includes the shortage recovery entered above.</label>
 <button className="button secondary" disabled={pending}>{pending?'Saving…':'Record recovery'}</button>
 {state.message?<p role="status">{state.message}</p>:null}
 </form></details>;
}
