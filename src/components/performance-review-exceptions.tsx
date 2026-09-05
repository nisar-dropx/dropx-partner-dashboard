"use client";

import { useState } from "react";
import type { PerformanceReview, PerformanceReviewStep } from "@/lib/ops-pulse/performance-review";
import { bypassPerformanceReviewLevel, proxyPerformanceReview } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

export function PerformanceReviewExceptions({ review, steps, canBypass, canProxy, canAccessBypass, canAccessProxy, canStart, hasRoute, routeLabel }: {
  review: PerformanceReview | null; steps: PerformanceReviewStep[]; canBypass: boolean; canProxy: boolean;
  canAccessBypass: boolean; canAccessProxy: boolean; canStart: boolean; hasRoute: boolean; routeLabel?: string;
}) {
  const [mode,setMode]=useState<"proxy"|"skip"|null>(null);
  const current=steps.find(step=>step.step_order===review?.current_step_order && step.status==="pending")
    ?? (!review ? steps.find(step=>step.status==="pending") : undefined);
  const pending=steps.filter(step=>step.status==="pending");
  if (!canAccessBypass&&!canAccessProxy) return null;
  const inactiveReason = !hasRoute
    ? "A review manager needs to be assigned in People. Contact HR so this station gets a Cluster Manager → National Head route."
    : !review
      ? canStart ? "Start review first for this station and date, then use Proxy or Skip."
        : "The review has not started for this station and date. Ask the assigned review manager to start it."
    : review.status==="closed" ? "Review completed. There are no pending levels to skip or cover."
    : !pending.length ? "There are no pending levels to skip or cover."
    : !current ? "The current review level is unavailable. Refresh the review before continuing." : null;
  const proxyEnabled=Boolean(review&&!inactiveReason&&canProxy);
  const skipEnabled=Boolean(review&&!inactiveReason&&canBypass);
  const proxyHint=inactiveReason || (canProxy?null:current?.proxy_reviewer_user_id
    ? "This level already has a proxy reviewer. Continue the assigned review or contact the Program Manager."
    : hasRoute
      ? "Proxy is for a higher manager or authorised oversight covering this station. If you are the assigned manager, complete your stage in Review discussion."
      : "Proxy needs a People review route for this station.");
  return <section className="review-exceptions" aria-label="Review cover and exceptions">
    <div className="review-exception-buttons">
      {canAccessProxy?<button type="button" className="button secondary" disabled={!proxyEnabled} aria-describedby={!proxyEnabled?"review-exception-guidance":undefined} onClick={()=>setMode(mode==="proxy"?null:"proxy")}>Conduct proxy review</button>:null}
      {canAccessBypass?<button type="button" className="button secondary" disabled={!skipEnabled} aria-describedby={inactiveReason?"review-exception-guidance":undefined} onClick={()=>setMode(mode==="skip"?null:"skip")}>Skip a level…</button>:null}
    </div>
    {inactiveReason||(!proxyEnabled&&canAccessProxy)?<p id="review-exception-guidance" className="review-exception-guidance">{inactiveReason||proxyHint}{!review&&canStart&&hasRoute?<> <a href="#start-station-review">Go to Start review ↑</a></>:null}{hasRoute&&routeLabel?<small className="review-exception-route"> Route: {routeLabel}</small>:null}</p>:null}
    {review&&mode&&(mode==="proxy"?proxyEnabled:skipEnabled)?<ReviewActionForm key={mode} action={mode==="proxy"?proxyPerformanceReview:bypassPerformanceReviewLevel} className="review-exception-form" onSaved={()=>setMode(null)}>
      <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={review.source_date}/><input type="hidden" name="station_code" value={review.station_code}/><input type="hidden" name="review_version" value={review.updated_at}/>
      {mode==="proxy"?<><input type="hidden" name="step_id" value={current?.id??""}/><p>You will conduct the review on behalf of <strong>{current?.reviewer_name}</strong>. Add the review inputs, then complete their level.</p></>:<><p>This level will be marked <strong>Skipped</strong>, not reviewed. The reason stays visible to everyone in this station’s review.</p><label>Pending level<select name="step_id" required>{pending.map(step=><option value={step.id} key={step.id}>{step.reviewer_role} · {step.reviewer_name}</option>)}</select></label></>}
      <label>{mode==="proxy"?"Why is the assigned manager unable to review?":"Why is this level being skipped?"}<textarea name="reason" required minLength={5} maxLength={2000} rows={2}/></label>
      <div className="review-exception-buttons"><button className="button">{mode==="proxy"?"Take proxy review":"Confirm skip"}</button><button type="button" className="button secondary" onClick={()=>setMode(null)}>Cancel</button></div>
    </ReviewActionForm>:null}
  </section>;
}
