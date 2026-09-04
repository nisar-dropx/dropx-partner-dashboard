"use client";

import { useState } from "react";
import type { PerformanceReview, PerformanceReviewStep } from "@/lib/ops-pulse/performance-review";
import { bypassPerformanceReviewLevel, proxyPerformanceReview } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

export function PerformanceReviewExceptions({ review, steps, canBypass, canProxy }: {
  review: PerformanceReview; steps: PerformanceReviewStep[]; canBypass: boolean; canProxy: boolean;
}) {
  const [mode,setMode]=useState<"proxy"|"skip"|null>(null);
  const current=steps.find(step=>step.step_order===review.current_step_order && step.status==="pending");
  const pending=steps.filter(step=>step.status==="pending");
  if ((!canBypass&&!canProxy)||!pending.length) return null;
  return <section className="review-exceptions" aria-label="Review cover and exceptions">
    <div className="review-exception-buttons">
      {canProxy?<button type="button" className="button secondary" onClick={()=>setMode(mode==="proxy"?null:"proxy")}>Conduct proxy review</button>:null}
      {canBypass?<button type="button" className="button secondary" onClick={()=>setMode(mode==="skip"?null:"skip")}>Skip a level…</button>:null}
    </div>
    {mode?<ReviewActionForm key={mode} action={mode==="proxy"?proxyPerformanceReview:bypassPerformanceReviewLevel} className="review-exception-form" onSaved={()=>setMode(null)}>
      <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={review.source_date}/><input type="hidden" name="station_code" value={review.station_code}/><input type="hidden" name="review_version" value={review.updated_at}/>
      {mode==="proxy"?<><input type="hidden" name="step_id" value={current?.id??""}/><p>You will conduct the review on behalf of <strong>{current?.reviewer_name}</strong>. Add the review inputs, then complete their level.</p></>:<><p>This level will be marked <strong>Skipped</strong>, not reviewed. The reason stays visible to everyone in this station’s review.</p><label>Pending level<select name="step_id" required>{pending.map(step=><option value={step.id} key={step.id}>{step.reviewer_role} · {step.reviewer_name}</option>)}</select></label></>}
      <label>{mode==="proxy"?"Why is the assigned manager unable to review?":"Why is this level being skipped?"}<textarea name="reason" required minLength={5} maxLength={2000} rows={2}/></label>
      <div className="review-exception-buttons"><button className="button">{mode==="proxy"?"Take proxy review":"Confirm skip"}</button><button type="button" className="button secondary" onClick={()=>setMode(null)}>Cancel</button></div>
    </ReviewActionForm>:null}
  </section>;
}
