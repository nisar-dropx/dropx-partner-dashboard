'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useCodFormState} from '@/app/ops-pulse/cod/submission/use-cod-form-state';
import {reviewCodSlip} from '@/app/ops-pulse/cod/pending/actions';

export function CodManualReviewForm({id,version,current}:{id:string;version:number;current?:string|null}){
 const router=useRouter();const [pending,setPending]=useState(false);
 const [state,action]=useCodFormState(reviewCodSlip,{ok:false,message:''});
 async function submit(form:FormData){if(pending)return;setPending(true);try{await action(form);router.refresh();}finally{setPending(false);}}
 return <details style={{marginTop:12}}><summary style={{cursor:'pointer',fontWeight:700}}>Review slip</summary>
  <form action={submit} style={{display:'grid',gap:8,marginTop:10,maxWidth:520}}>
   <input type="hidden" name="submission_id" value={id}/><input type="hidden" name="proof_version" value={version}/>
   <label>Decision<select className="field" name="decision" defaultValue={current==='Valid'?'Valid':'Not valid'}><option value="Valid">Valid</option><option value="Not valid">Needs correction</option></select></label>
   <label>Reason / note<textarea className="field" name="reason" maxLength={300} rows={2} placeholder="Required when correction is needed"/></label>
   <label style={{display:'flex',gap:8,alignItems:'flex-start'}}><input name="review_confirmed" type="checkbox" value="yes" required/> <span>I checked the CMS/bank slip, deposited amount and bank/CMS seal.</span></label>
   <button className="button primary" disabled={pending}>{pending?'Saving…':'Save review'}</button>
   {state.message?<p role="status" style={{color:state.ok?'#166534':'#b91c1c'}}>{state.message}</p>:null}
  </form>
 </details>;
}
