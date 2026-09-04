"use client";

import { useState } from "react";
import type { PerformanceFollowup, PerformanceReview } from "@/lib/ops-pulse/performance-review";
import { savePerformanceFollowup } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

const day=(value:string)=>value.split("-").reverse().join("/");
function ActionForm({review,item,onSaved}:{review:PerformanceReview;item?:PerformanceFollowup;onSaved?:()=>void}) {
  return <ReviewActionForm action={savePerformanceFollowup} className="review-followup-form" onSaved={onSaved}>
    <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={review.source_date}/><input type="hidden" name="station_code" value={review.station_code}/><input type="hidden" name="id" value={item?.id??""}/><input type="hidden" name="version" value={item?.version??0}/>
    <label className="wide">Action<textarea name="title" required maxLength={2000} rows={2} defaultValue={item?.title??""} placeholder="What needs to be done?"/></label>
    <label>Owner<input name="owner_label" required maxLength={250} defaultValue={item?.owner_label??""}/></label>
    <label>ETA<input name="due_date" type="date" min={item?.source_date??review.source_date} required defaultValue={item?.due_date??review.source_date}/></label>
    <label>Status<select name="status" defaultValue={item?.status??"open"}><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
    {item?<label className="wide">Progress note<textarea name="progress_note" maxLength={2000} rows={2} defaultValue={item.progress_note??""}/></label>:null}
    <button className="button secondary">{item?"Save progress":"Add action"}</button>
  </ReviewActionForm>;
}
export function PerformanceFollowups({review,date,rows,count,error,canAdd,canUpdate}:{review:PerformanceReview|null;date:string;rows:PerformanceFollowup[];count:number;error:string|null;canAdd:boolean;canUpdate:boolean}) {
  const [adding,setAdding]=useState(false);
  const [showDone,setShowDone]=useState(false);
  const visible=rows.filter(item=>showDone||item.status!=="done");
  const open=rows.filter(item=>item.status!=="done");
  return <section className="review-followups" aria-label="Station action items">
    <header><div><h3>Action items <small>{open.length} open</small></h3><p>Actions carry into the next review until done. Closing a review does not close its actions.</p></div>{review&&canAdd?<button type="button" className="button secondary" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Action"}</button>:null}</header>
    {error?<p role="alert">{error}</p>:null}
    {review&&canAdd&&adding?<ActionForm key={rows.length} review={review} onSaved={()=>setAdding(false)}/>:null}
    {rows.some(item=>item.status==="done")?<label className="review-done-toggle"><input type="checkbox" checked={showDone} onChange={e=>setShowDone(e.target.checked)}/>Show completed actions</label>:null}
    {visible.map(item=><details key={item.id} className={item.status}>
      <summary><span><strong>Action {item.action_number} · {item.title}</strong><small>From {day(item.source_date)} · {item.owner_label} · ETA {day(item.due_date)}</small></span><b>{item.status==="done"?"Done":item.due_date<date?"Overdue":item.due_date===date?"Due this review":item.status.replace("_"," ")}</b></summary>
      {item.progress_note?<p>{item.progress_note}</p>:null}
      {review&&canUpdate?<ActionForm key={item.version} item={item} review={review}/>:null}
      <small>Updated by {item.updated_by_name} · {new Date(item.updated_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</small>
    </details>)}
    {!visible.length&&!error?<p className="review-empty">{rows.length?"No open action items.":review?"No action items recorded yet.":"Start the review to add action items."}</p>:null}
    {count>rows.length?<p>Showing {rows.length} of {count} actions, unresolved first.</p>:null}
  </section>;
}
