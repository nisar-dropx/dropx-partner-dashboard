import type { PerformanceReview,PerformanceReviewItem,PerformanceReviewCarryover } from "@/lib/ops-pulse/performance-review";
import { ReviewActionForm } from "@/components/review-action-form";
import { updateCarriedReviewAction } from "@/app/ops-pulse/performance/actions";
import { formatDashboardDate } from "@/lib/date-format";
export function PerformanceCarriedActions({items,previous,review,canUpdate}:{items:PerformanceReviewItem[];previous:PerformanceReviewCarryover[];review:PerformanceReview|null;canUpdate:boolean}) {
  if(!items.length)return null;
  return <details className="review-followups" open><summary>Earlier RCA actions · {items.filter(item=>item.status!=="done").length} open</summary>{items.map(item=><details key={item.id}>
    <summary><span><strong>{item.metric_label} · {item.corrective_action||"Action pending"}</strong><small>From {formatDashboardDate(previous.find(row=>row.id===item.review_id)?.source_date??"")} · {item.action_owner||"Owner pending"} · ETA {item.due_date?formatDashboardDate(item.due_date):"Not set"}</small></span><b>{item.status==="done"?"Done":item.due_date&&review&&item.due_date<review.source_date?"Overdue":item.status.replace("_"," ")}</b></summary>
    <p>{item.root_cause}</p>
    {review&&canUpdate?<ReviewActionForm action={updateCarriedReviewAction} className="review-followup-form" key={item.updated_at}>
      <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="station_code" value={review.station_code}/><input type="hidden" name="source_date" value={review.source_date}/><input type="hidden" name="item_id" value={item.id}/><input type="hidden" name="item_version" value={item.updated_at}/>
      <label>Status<select name="status" defaultValue={item.status}><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
      <label>Progress note<textarea name="progress_note" required maxLength={2000} rows={2}/></label><button className="button secondary">Save progress</button>
    </ReviewActionForm>:null}
  </details>)}</details>;
}
