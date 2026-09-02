import Link from "next/link";
import { formatDashboardDate } from "@/lib/date-format";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { PerformanceOperationalSnapshot, PerformanceReview, PerformanceReviewItem, PerformanceReviewStep } from "@/lib/ops-pulse/performance-review";
import { completePerformanceReviewStep, savePerformanceReviewItem, savePerformanceReviewOperations, startPerformanceReview } from "@/app/ops-pulse/performance/actions";

export type ReviewMetric = {
  actual: number | null;
  direction: "higher" | "lower";
  key: string;
  label: string;
  severity: "green" | "amber" | "red" | "neutral";
  short: string;
  target: number | null;
};

type Props = {
  canEdit: boolean;
  date: string;
  error: string | null;
  items: PerformanceReviewItem[];
  locations: CodLocationRow[];
  metrics: ReviewMetric[];
  notice: string | null;
  review: PerformanceReview | null;
  selectedLocation: CodLocationRow;
  snapshot: PerformanceOperationalSnapshot;
  sourceBatchId: string | null;
  sourceType: string;
  sourceWeek: number;
  steps: PerformanceReviewStep[];
};

function money(value: number | null | undefined) {
  return value == null ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function valueText(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function timeText(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);
  return value.slice(0, 5);
}

export function PerformanceReviewDesk(props: Props) {
  const { canEdit, date, error, items, locations, metrics, notice, review, selectedLocation, snapshot, sourceBatchId, sourceType, sourceWeek, steps } = props;
  const itemByMetric = new Map(items.filter((item) => item.review_id === review?.id).map((item) => [item.metric_key, item]));
  const carriedActions = items.filter((item) => item.review_id !== review?.id && item.status !== "done").slice(0, 12);
  const misses = metrics.filter((metric) => metric.severity === "red" || metric.severity === "amber");
  const activeStep = review ? steps.find((step) => step.review_id === review.id && step.step_order === review.current_step_order) ?? null : null;
  const selectedCode = selectedLocation.station_code;
  return <div className="performance-review-desk">
    {notice ? <div className="performance-review-message success">{notice}</div> : null}
    {error ? <div className="performance-review-message error">{error}</div> : null}
    <section className="ops-control-strip performance-review-control">
      <div className="ops-context-summary"><span>Station review</span><strong>{formatDashboardDate(date)}</strong><small>{selectedCode} · {selectedLocation.station_name || selectedLocation.city || "Station"}</small></div>
      <form className="performance-review-picker">
        <input type="hidden" name="view" value="reviews" />
        <label>Date<input type="date" name="date" defaultValue={date} /></label>
        <label>Station<select name="review" defaultValue={selectedCode}>{locations.map((location) => <option key={location.id} value={location.station_code}>{location.station_code} · {location.station_name || location.city || location.station_code}</option>)}</select></label>
        <button>Open</button>
      </form>
    </section>

    <section className="performance-review-statusbar">
      <div><span>Source</span><strong>{sourceType === "amazon_hawkeye_daily" ? "Hawkeye D-1" : sourceType === "daily_edsp_metrics" ? "Daily EDSP" : "Operational data"}</strong></div>
      <div><span>Review</span><strong>{review ? review.status.replace("_", " ") : "Not started"}</strong></div>
      <div><span>Current dependency</span><strong>{activeStep ? `${activeStep.reviewer_role} · ${activeStep.reviewer_name}` : review?.status === "closed" ? "Completed" : "Start review"}</strong></div>
      {!review && canEdit ? <form action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button className="button">Start review</button></form> : null}
    </section>

    {review ? <section className="performance-review-flow" aria-label="Review workflow">
      {steps.filter((step) => step.review_id === review.id).map((step) => <div className={`${step.status} ${step.step_order === review.current_step_order ? "current" : ""}`} key={step.id}><i>{step.step_order}</i><span>{step.reviewer_role}<small>{step.reviewer_name}</small></span></div>)}
    </section> : null}

    <div className="performance-review-columns">
      <section className="panel performance-review-section">
        <div className="panel-head"><div><span className="performance-review-kicker">01 · PERFORMANCE</span><h2>D-1 station performance</h2><p className="subtle">Uploaded Amazon metrics, opening discipline and action ownership in one review.</p></div><strong className={misses.length ? "review-risk" : "review-good"}>{misses.length} exception{misses.length === 1 ? "" : "s"}</strong></div>
        <div className="performance-review-facts">
          <article><span>Delivered</span><strong>{snapshot.deliveredCount.toLocaleString("en-IN")}</strong><small>Detailed delivered source</small></article>
          <article><span>Average allocation</span><strong>{snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)}</strong><small>{snapshot.activeFeCount} active FE IDs</small></article>
          <article><span>Station opened</span><strong>{timeText(snapshot.firstPunchAt)}</strong><small>{snapshot.firstPunchBy || "No first punch"}</small></article>
          <article><span>Metric health</span><strong>{metrics.length - misses.length}/{metrics.length}</strong><small>Within configured range</small></article>
        </div>
        {carriedActions.length ? <details className="performance-inline-detail carried-review-actions" open><summary><span>Open actions from earlier reviews</span><b>{carriedActions.length} carried</b></summary><div>{carriedActions.map((item) => <article key={item.id}><span><strong>{item.metric_label}</strong><small>{item.root_cause || "RCA pending"}</small></span><span><b>{item.corrective_action || "Action pending"}</b><small>{item.action_owner || "Owner pending"}{item.due_date ? ` · due ${formatDashboardDate(item.due_date)}` : ""}</small></span><em>{item.status.replace("_", " ")}</em></article>)}</div></details> : null}
        <details className="performance-inline-detail" open>
          <summary><span>Performance scorecard</span><b>{metrics.length} metrics</b></summary>
          <div className="performance-review-metrics">{metrics.map((metric) => <article className={metric.severity} key={metric.key}><span>{metric.short}</span><strong>{valueText(metric.actual)}</strong><small>{metric.target == null ? "Reference" : `${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}</small></article>)}</div>
        </details>
        {review && canEdit ? <form action={savePerformanceReviewOperations} className="performance-operations-form">
          <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/>
          <label>Vehicle arrival<input type="time" name="vehicle_arrival_time" defaultValue={review.vehicle_arrival_time?.slice(0, 5) ?? ""}/></label>
          <label>Unloading complete<input type="time" name="unloading_complete_time" defaultValue={review.unloading_complete_time?.slice(0, 5) ?? ""}/></label>
          <label>Station clear<input type="time" name="station_clear_time" defaultValue={review.station_clear_time?.slice(0, 5) ?? ""}/></label>
          <label className="wide">Review summary<textarea name="review_summary" defaultValue={review.review_summary ?? ""} placeholder="Only the key conclusion or escalation"/></label>
          <button className="button secondary">Save details</button>
        </form> : null}
        {review && misses.length ? <div className="performance-review-actions"><h3>RCA and next-day actions</h3>{misses.map((metric) => {
          const item = itemByMetric.get(metric.key);
          return <details className="performance-action-item" key={`action-${metric.key}`} open={Boolean(item && item.status !== "done")}><summary><span className={`metric-dot ${metric.severity}`}/><strong>{metric.label}</strong><b>{item?.status?.replace("_", " ") || "Needs RCA"}</b></summary>{canEdit ? <form action={savePerformanceReviewItem}>
            <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="metric_key" value={metric.key}/><input type="hidden" name="metric_label" value={metric.label}/><input type="hidden" name="actual_value" value={metric.actual ?? ""}/><input type="hidden" name="target_value" value={metric.target ?? ""}/><input type="hidden" name="target_direction" value={metric.direction}/><input type="hidden" name="severity" value={metric.severity}/>
            <label>Root cause<textarea required name="root_cause" defaultValue={item?.root_cause ?? ""} placeholder="What caused the miss?"/></label>
            <label>Next action<textarea required name="corrective_action" defaultValue={item?.corrective_action ?? ""} placeholder="Specific action before next review"/></label>
            <label>Owner<input required name="action_owner" defaultValue={item?.action_owner ?? ""}/></label><label>Due<input type="date" name="due_date" defaultValue={item?.due_date ?? date}/></label><label>Status<select name="status" defaultValue={item?.status ?? "open"}><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label><button className="button secondary">Save action</button>
          </form> : <div className="performance-action-readonly"><p><b>RCA</b>{item?.root_cause || "Awaiting update"}</p><p><b>Action</b>{item?.corrective_action || "Awaiting update"}</p></div>}</details>;
        })}</div> : null}
      </section>

      <section className="panel performance-review-section performance-cps-review">
        <div className="panel-head"><div><span className="performance-review-kicker">02 · CPS</span><h2>Cost and allocation</h2><p className="subtle">Click any cost card to see its contributing lines and approvals here.</p></div></div>
        <div className="performance-cps-cards">
          <details><summary><span>Salary DA CPS</span><strong>{money(snapshot.salaryDaCps)}</strong><small>{money(snapshot.salaryDaCost)} total</small></summary><div><p><span>Per-shipment / variable</span><b>{money(snapshot.variableDaPay)}</b></p><p><span>MG / salary</span><b>{money(snapshot.mgSalaryPay)}</b></p><p><span>Kilometre / fuel</span><b>{money(snapshot.fuelPay)}</b></p><p><span>FE payment setup gaps</span><b>{snapshot.unmappedFeCount}</b></p></div></details>
          <details><summary><span>Ad-hoc van</span><strong>{money(snapshot.adHocVanCost)}</strong><small>{snapshot.adHocVanRequests.length} approved request{snapshot.adHocVanRequests.length === 1 ? "" : "s"}</small></summary><div>{snapshot.adHocVanRequests.length ? snapshot.adHocVanRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}</span><b>{money(request.amount)}</b></p>) : <p><span>No approved ad-hoc van request</span><b>₹0</b></p>}</div></details>
          <details><summary><span>Ad-hoc DA</span><strong>{money(snapshot.adHocDaCost)}</strong><small>{snapshot.adHocDaRequests.length} approved request{snapshot.adHocDaRequests.length === 1 ? "" : "s"}</small></summary><div>{snapshot.adHocDaRequests.length ? snapshot.adHocDaRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}</span><b>{money(request.amount)}</b></p>) : <p><span>No approved ad-hoc DA request</span><b>₹0</b></p>}</div></details>
          <details><summary><span>Daily CPS</span><strong>{money(snapshot.dailyCps)}</strong><small>{money(snapshot.dayCost)} total cost</small></summary><div>{snapshot.costBreakdown.length ? snapshot.costBreakdown.map((line, index) => <p key={`${line.head}-${line.subHead}-${index}`}><span>{line.head} · {line.subHead}<small>{line.source}</small></span><b>{money(line.amount)}<small>{money(line.cps)} CPS</small></b></p>) : <p><span>No cost breakup loaded</span><b>—</b></p>}</div></details>
          <details><summary><span>MTD CPS</span><strong>{money(snapshot.mtdCps)}</strong><small>{money(snapshot.mtdCost)} / {snapshot.mtdDelivery.toLocaleString("en-IN")} delivered</small></summary><div><p><span>Month-to-date cost</span><b>{money(snapshot.mtdCost)}</b></p><p><span>Month-to-date delivery</span><b>{snapshot.mtdDelivery.toLocaleString("en-IN")}</b></p><p><span>Includes configured DA, UTR, van, fuel, rent and other heads</span><b>All heads</b></p></div></details>
          <details><summary><span>Allocation</span><strong>{snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)}</strong><small>{snapshot.deliveredCount.toLocaleString("en-IN")} deliveries / {snapshot.activeFeCount} FEs</small></summary><div><p><span>Delivered shipments</span><b>{snapshot.deliveredCount.toLocaleString("en-IN")}</b></p><p><span>Active FE IDs</span><b>{snapshot.activeFeCount}</b></p></div></details>
        </div>
        <div className="performance-cps-note"><strong>Cost completeness</strong><span>Values appear only when their source is loaded or configured. Missing rent, UTR or payment mappings remain visible as a data gap; OpsPulse does not estimate them.</span><Link href="/cps/inputs">Open CPS inputs →</Link></div>
      </section>
    </div>

    {review && review.status !== "closed" && canEdit ? <section className="performance-review-complete"><div><strong>Complete {activeStep?.reviewer_role || "current"} review</strong><span>The action moves to the next configured reporting layer. Open actions remain visible in tomorrow’s review.</span></div><form action={completePerformanceReviewStep}><input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input name="feedback" placeholder="Review feedback or escalation note"/><button className="button">Complete step</button></form></section> : null}
  </div>;
}
