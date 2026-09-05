import type { PerformanceReview,PerformanceReviewItem,PerformanceReviewCarryover } from "@/lib/ops-pulse/performance-review";
import { ReviewActionForm } from "@/components/review-action-form";
import { updateCarriedReviewAction } from "@/app/ops-pulse/performance/actions";
import { formatDashboardDate } from "@/lib/date-format";

export function PerformanceCarriedActions({
  items,
  previous,
  review,
  canUpdate,
  selectedDate
}:{
  items:PerformanceReviewItem[];
  previous:PerformanceReviewCarryover[];
  review:PerformanceReview|null;
  canUpdate:boolean;
  selectedDate:string;
}) {
  if(!items.length)return null;
  const openCount=items.filter(item=>item.status!=="done").length;
  const asOf=review?.source_date||selectedDate;
  return <details className="review-followups" open>
    <summary>
      <span>
        <strong>Open actions from earlier review days · {openCount} still open</strong>
        <small>Carry-forward tracker — these stay here until marked Done. They are not today’s Hawkeye scorecard.</small>
      </span>
    </summary>
    <p className="review-followups-guide">
      Today’s uploaded Amazon metrics appear in the <strong>Performance scorecard</strong> below.
      New misses for this date get new RCA rows after you start today’s review.
      Update status here when an older action is finished.
    </p>
    {items.map(item=>{
      const fromDate=previous.find(row=>row.id===item.review_id)?.source_date??"";
      const overdue=Boolean(item.due_date&&item.due_date<asOf&&item.status!=="done");
      return <details key={item.id} className={item.status==="done"?"done":undefined}>
        <summary>
          <span>
            <strong>{item.metric_label} · {item.corrective_action||"Action pending"}</strong>
            <small>From review {formatDashboardDate(fromDate)} · {item.action_owner||"Owner pending"} · ETA {item.due_date?formatDashboardDate(item.due_date):"Not set"}</small>
          </span>
          <b>{item.status==="done"?"Done":overdue?"Overdue":item.status.replace("_"," ")}</b>
        </summary>
        <p>{item.root_cause}</p>
        {review&&canUpdate?<ReviewActionForm action={updateCarriedReviewAction} className="review-followup-form" key={item.updated_at}>
          <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="station_code" value={review.station_code}/><input type="hidden" name="source_date" value={review.source_date}/><input type="hidden" name="item_id" value={item.id}/><input type="hidden" name="item_version" value={item.updated_at}/>
          <label>Status<select name="status" defaultValue={item.status}><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
          <label>Progress note<textarea name="progress_note" required maxLength={2000} rows={2}/></label><button className="button secondary">Save progress</button>
        </ReviewActionForm>:!review?<p className="review-empty">Start today’s review to update progress on these carry-forward actions.</p>:null}
      </details>;
    })}
  </details>;
}
