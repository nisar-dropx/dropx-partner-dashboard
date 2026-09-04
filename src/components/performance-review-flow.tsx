"use client";
import { useState } from "react";
import type { PerformanceReviewStep } from "@/lib/ops-pulse/performance-review";

export function PerformanceReviewFlow({steps,currentOrder,stationLeads}:{steps:PerformanceReviewStep[];currentOrder:number;stationLeads:string}) {
  const [selected,setSelected]=useState(steps.findIndex(step=>step.step_order===currentOrder));
  const index=selected>=0&&selected<steps.length?selected:0;
  const step=steps[index];
  const counterpart=index>0?`${steps[index-1].reviewer_name} · ${steps[index-1].reviewer_role}`:stationLeads;
  return <section className="review-manager-flow" aria-label="Who reviews with whom">
    <div className="review-manager-tabs">{steps.map((entry,i)=><button type="button" key={entry.id} className={`${entry.status} ${i===index?"selected":""}`} aria-pressed={i===index} onClick={()=>setSelected(i)}>
      <i>{entry.status==="completed"?"✓":entry.status==="skipped"?"–":i+1}</i><span>{entry.reviewer_name}<small>{entry.reviewer_role}</small><small>{entry.status==="completed"?"Reviewed":entry.status==="skipped"?"Skipped":entry.step_order===currentOrder?"Reviewing now":"Up next"}</small></span>
    </button>)}</div>
    {step?<div className="review-manager-context"><p><strong>{step.proxy_reviewer_name||step.reviewer_name}</strong> {step.status==="completed"?"reviewed":"conducts review"} with <strong>{counterpart}</strong>.</p>
      {step.proxy_reviewer_name?<p className="review-proxy-badge">Proxy for {step.reviewer_name} · {step.proxy_reason}</p>:null}
      {step.bypassed_at?<p className="review-skip-badge">Skipped by {step.bypassed_by_name} · {step.bypass_reason}</p>:null}
      {step.feedback?<blockquote>{step.feedback}</blockquote>:null}
    </div>:null}
  </section>;
}
