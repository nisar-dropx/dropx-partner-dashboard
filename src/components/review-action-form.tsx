"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ReviewActionResult } from "@/app/ops-pulse/performance/actions";

export function ReviewActionForm({ action, children, className, resetOnSuccess=false, onSaved }: {
  action: (data: FormData) => Promise<ReviewActionResult>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  onSaved?: () => void;
}) {
  const router=useRouter();
  const [refreshing,startTransition]=useTransition();
  const [saving,setSaving]=useState(false);
  const busy=useRef(false);
  const pending=saving||refreshing;
  const [result,setResult]=useState<ReviewActionResult>({});
  return <form className={className} onSubmit={async(event)=>{
    event.preventDefault();
    if(busy.current)return;
    const form=event.currentTarget;
    const data=new FormData(form);
    const submitter=(event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;
    if(submitter?.name)data.set(submitter.name,submitter.value);
    setResult({});
    busy.current=true;
    setSaving(true);
      try {
        const saved=await action(data);
        setResult(saved);
        if(!saved.error){
          if(resetOnSuccess)form.reset();
          startTransition(()=>router.refresh());
          onSaved?.();
        }
      }catch{setResult({error:"Unable to save. Please refresh and try again."});}
      finally{busy.current=false;setSaving(false);}
  }} aria-busy={pending}>
    {/* div + display:contents — fieldset+contents hides children in Chromium */}
    <div className={`review-action-fields${pending ? " is-pending" : ""}`}>{children}</div>
    {(pending||result.error||result.notice)?<p className={`review-save-result ${result.error?"error":""}`} role={result.error?"alert":"status"}>{pending?"Saving…":result.error||result.notice}</p>:null}
  </form>;
}
