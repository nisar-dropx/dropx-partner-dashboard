"use client";
import { useState } from "react";
import { DisputeQuestionnaire } from "../../../../src/components/dispute-questionnaire";
import s from "../../../../src/components/guided-dispute.module.css";
export function AssociateDisputeRequest({ payout, query, onSaved, readOnly=false }: { payout:any; query:string; onSaved:()=>void; readOnly?:boolean }) {
  const [draft,setDraft]=useState<any>({}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function send(e:React.FormEvent<HTMLFormElement>){e.preventDefault();if(readOnly)return;setBusy(true);setError("");try{
    const form=new FormData(e.currentTarget);form.set("payload",JSON.stringify({operation:"create",publicationId:payout.publicationId,details:draft}));
    const r=await fetch(`/api/connect/payout-review?${query}`,{method:"POST",body:form});const b=await r.json();if(!r.ok)throw new Error(b.error);onSaved();
  }catch(e){setError(e instanceof Error?e.message:"Could not send your request.");}finally{setBusy(false);}}
  const issueReady=draft.issue&&draft.component&&draft.concern&&(["deduction","allowance"].includes(draft.issue)||draft.dates?.length);
  return <form onSubmit={send} className={s.panel}>
    <DisputeQuestionnaire items={payout.disputeItems??[]} days={payout.disputeDays??[]} value={draft} onChange={setDraft}/>
    {draft.issue?<details style={{marginTop:12}}><summary>Add a photo or document <small>(optional)</small></summary><input type="file" name="attachment" accept="image/jpeg,image/png,image/webp,application/pdf"/><small>JPG, PNG, WebP or PDF · up to 4 MB</small></details>:null}
    {issueReady?<p className={s.muted}>Request: {draft.concern}{draft.dates?.length?` · ${draft.dates.length} selected date(s)`:""}. You can track the response in Disputes.</p>:null}
    {error?<p role="alert" className={s.error}>{error}</p>:null}
    <div className={s.actions}><button type="submit" disabled={!issueReady||busy||readOnly}>{readOnly?"Read-only preview":busy?"Sending…":"Send request"}</button></div>
  </form>;
}
