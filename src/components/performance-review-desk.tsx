import Link from "next/link";
import { formatDashboardDate } from "@/lib/date-format";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { PerformanceAssociateDelivery, PerformanceOperationalSnapshot, PerformanceReview, PerformanceReviewCarryover, PerformanceReviewItem, PerformanceReviewStep, PerformanceConnection, PerformanceReviewUpdate, PerformanceReviewChainStep } from "@/lib/ops-pulse/performance-review";
import { savePerformanceReviewComment, savePerformanceReviewItem, savePerformanceReviewOperations, startPerformanceReview } from "@/app/ops-pulse/performance/actions";
import { PerformanceReviewPicker } from "@/components/performance-review-picker";
import { PerformanceConnections } from "@/components/performance-connections";
import { ReviewActionForm } from "@/components/review-action-form";
import { reviewRole } from "@/lib/ops-pulse/review-policy";

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
  canAdd: boolean;
  canCompleteStep: boolean;
  canEdit: boolean;
  canEditConnections: boolean;
  canComment: boolean;
  programManager: boolean;
  connections: PerformanceConnection[];
  updates: PerformanceReviewUpdate[];
  reviewChain: PerformanceReviewChainStep[];
  routingIssue: string | null;
  date: string;
  error: string | null;
  items: PerformanceReviewItem[];
  locations: CodLocationRow[];
  metrics: ReviewMetric[];
  notice: string | null;
  previousReviews: PerformanceReviewCarryover[];
  review: PerformanceReview | null;
  reviews: PerformanceReview[];
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

function durationText(minutes: number | null) {
  if (minutes == null) return "Shift not linked";
  if (minutes <= 0) return "On time";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min late`;
  return `${hours} hr${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""} late`;
}

function AssociateDeliveryBreakdown({ rows, total }: { rows: PerformanceAssociateDelivery[]; total: number }) {
  return <div className="performance-associate-popover">
    <div className="performance-associate-popover-scroll">
      <div className="performance-associate-popover-head"><span>Associate</span><span>Delivered</span><span>Assigned</span><span>Payment scheme</span><span>Current rate card</span></div>
      <div className="performance-associate-popover-body">{rows.length ? rows.map((person) => <div className="performance-associate-row" key={`${person.associateId}-${person.name}`}>
        <span><strong>{person.name}</strong><small>{person.associateId}</small></span>
        <b>{person.delivered.toLocaleString("en-IN")}</b>
        <b>{person.assigned && person.assigned > 0 ? person.assigned.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "—"}</b>
        <span>{person.paymentScheme || "—"}</span>
        <span>{person.rateCard || "—"}</span>
      </div>) : <p>No associate-level delivery rows are available for this date.</p>}</div>
    </div>
    <div className="performance-associate-popover-foot"><span>{rows.length} delivering associate{rows.length === 1 ? "" : "s"}</span><b>{total.toLocaleString("en-IN")} total delivered</b></div>
  </div>;
}

export function PerformanceReviewDesk(props: Props) {
  const { canAdd, canCompleteStep, canEdit, canEditConnections, canComment, programManager, connections, updates, reviewChain, date, error, items, locations, metrics, notice, previousReviews, review, reviews, selectedLocation, snapshot, sourceBatchId, sourceType, sourceWeek, steps } = props;
  const selectedCode = selectedLocation.station_code;
  const previousStationReviews = previousReviews.filter((entry) => entry.station_code === selectedCode);
  const previousReview = previousStationReviews[0] ?? null;
  const selectedReviewIds = new Set([review?.id, ...previousStationReviews.map((entry) => entry.id)].filter(Boolean));
  const selectedItems = items.filter((item) => selectedReviewIds.has(item.review_id));
  const itemByMetric = new Map(selectedItems.filter((item) => item.review_id === review?.id).map((item) => [item.metric_key, item]));
  const carriedActions = selectedItems.filter((item) => item.review_id !== review?.id && item.status !== "done").slice(0, 12);
  const misses = metrics.filter((metric) => metric.severity === "red" || metric.severity === "amber");
  const activeStep = review ? steps.find((step) => step.review_id === review.id && step.step_order === review.current_step_order) ?? null : null;
  const reviewByStation = new Map(reviews.map((entry) => [entry.station_code, entry]));
  const completedCount = locations.filter((location) => reviewByStation.get(location.station_code)?.status === "closed").length;
  const inReviewCount = locations.filter((location) => reviewByStation.get(location.station_code)?.status === "in_review").length;
  const notStartedCount = locations.length - completedCount - inReviewCount;
  const openingIsLate = (snapshot.openingLateMinutes ?? 0) > 0;
  const selectedSteps = steps.filter((step) => step.review_id === review?.id && step.status !== "skipped" && ["cluster","aom","national"].includes(reviewRole(step.reviewer_role)));
  const reviewUpdates = updates.filter((update) => update.review_id === review?.id);
  return <div className="performance-review-desk">
    {notice ? <div className="performance-review-message success">{notice}</div> : null}
    {error ? <div className="performance-review-message error">{error}</div> : null}
    {locations.length > 1 ? <details className="performance-review-overview" open><summary><span><strong>All-station review status</strong><small>{formatDashboardDate(date)} · permitted scope only</small></span><span className="performance-review-overview-counts"><b>{completedCount} done</b><b>{inReviewCount} active</b><b>{notStartedCount} not started</b></span></summary><div>{locations.map((location) => {
      const stationReview = reviewByStation.get(location.station_code);
      const stationStep = stationReview ? steps.find((step) => step.review_id === stationReview.id && step.step_order === stationReview.current_step_order) : null;
      return <article key={location.id}><span><strong>{location.station_code}</strong><small>{location.station_name || location.city || "Station"}</small></span><em className={stationReview?.status || "not-started"}>{stationReview?.status?.replace("_", " ") || "Not started"}</em><p>{stationReview?.review_summary || (stationReview?.status === "closed" ? "Completed without a takeaway" : "Takeaway pending")}</p><span><b>{stationStep ? `${stationStep.reviewer_name} · ${stationStep.reviewer_role}` : stationReview?.status === "closed" ? "Completed" : "—"}</b><Link href={`/performance?view=reviews&date=${date}&review=${location.station_code}`}>Open</Link></span></article>;
    })}</div></details> : null}
    <section className="ops-control-strip performance-review-control">
      <div className="ops-context-summary"><span>Loaded performance date</span><strong>{formatDashboardDate(date)}</strong><small>{selectedCode} · {selectedLocation.station_name || selectedLocation.city || "Station"}</small></div>
      <PerformanceReviewPicker
        date={date}
        locations={locations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code }))}
        stationCode={selectedCode}
      />
    </section>

    <section className="performance-review-statusbar">
      <div><span>Source</span><strong>{sourceType === "amazon_hawkeye_daily" ? "Hawkeye D-1" : sourceType === "daily_edsp_metrics" ? "Daily EDSP" : "Operational data"}</strong></div>
      <div><span>Review</span><strong>{review ? review.status.replace("_", " ") : "Not started"}</strong></div>
      <div><span>Current dependency</span><strong>{activeStep ? `${activeStep.reviewer_role} · ${activeStep.reviewer_name}` : review?.status === "closed" ? "Completed" : "Start review"}</strong></div>
      {!review && canAdd ? <ReviewActionForm action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button className="button">Start review</button></ReviewActionForm> : null}
    </section>

    {!review && misses.length ? <section className="performance-review-start-guide"><div><strong>{misses.length} metrics need RCA and action</strong><span>{canAdd ? "Start this station review to assign the RCA, action owner, due date and follow-up status." : "The first review manager will start the review and record RCA and actions."}</span></div>{canAdd ? <ReviewActionForm action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button className="button">Start & add RCA</button></ReviewActionForm> : null}</section> : null}
    {props.routingIssue ? <div className="alert warning" role="status">{props.routingIssue}</div> : null}

    <section className="performance-review-flow" aria-label="Review workflow">
      {review ? selectedSteps.map((step,index) => <div className={`${step.status} ${step.step_order === review.current_step_order ? "current" : ""}`} key={step.id}><i>{step.status === "completed" ? "✓" : index+1}</i><span>{step.reviewer_role}<small>{step.reviewer_name}</small><small>{step.status === "completed" ? "Reviewed" : step.step_order === review.current_step_order ? "Reviewing now" : "Up next"}</small></span></div>) : reviewChain.map((step,index)=><div key={`${step.reviewerUserId}-${index}`}><i>{index+1}</i><span>{step.reviewerRole}<small>{step.reviewerName}</small></span></div>)}
      <p className="review-access-hint">{programManager?"Program Manager · edit and comment at any stage":canEditConnections&&!canComment?"Station access · update connection timings; view the full review":canEdit?"Your review · update RCA, actions and takeaway":canComment?"Your review · add comments and complete your stage":"View the full review · comments open at your review stage"}</p>
    </section>

    <PerformanceConnections connections={connections} date={date} stationCode={selectedCode} canEdit={canEditConnections}/>

    <div className="performance-review-columns">
      <section className="panel performance-review-section">
        <div className="panel-head"><div><span className="performance-review-kicker">01 · PERFORMANCE</span><h2>D-1 station performance</h2><p className="subtle">Uploaded Amazon metrics, opening discipline and action ownership in one review.</p></div><strong className={misses.length ? "review-risk" : "review-good"}>{misses.length} exception{misses.length === 1 ? "" : "s"}</strong></div>
        <div className="performance-review-facts">
          <details className="performance-fact-card" name="performance-review-fact"><summary><span>Delivered · view split</span><strong>{snapshot.deliveredCount.toLocaleString("en-IN")}</strong><small>{snapshot.associateDeliveries.length} delivering associate{snapshot.associateDeliveries.length === 1 ? "" : "s"}</small></summary><AssociateDeliveryBreakdown rows={snapshot.associateDeliveries} total={snapshot.deliveredCount}/></details>
          <details className="performance-fact-card" name="performance-review-fact"><summary><span>Average allocation · view split</span><strong>{snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)}</strong><small>{snapshot.deliveredCount.toLocaleString("en-IN")} deliveries / {snapshot.activeFeCount} active FEs</small></summary><AssociateDeliveryBreakdown rows={snapshot.associateDeliveries} total={snapshot.deliveredCount}/></details>
          <details className={`performance-fact-card opening ${openingIsLate ? "late" : ""}`} name="performance-review-fact"><summary><span>Station opened · shift check</span><strong>{timeText(snapshot.firstPunchAt)}</strong><small>{snapshot.scheduledOpeningTime ? <b className={openingIsLate ? "late" : "on-time"}>{durationText(snapshot.openingLateMinutes)}</b> : null}{snapshot.firstPunchBy || "No valid opening punch"}</small></summary><div className="performance-opening-popover"><p><span>Station opening shift</span><b>{timeText(snapshot.scheduledOpeningTime)}</b></p><p><span>Opening punch</span><b>{timeText(snapshot.firstPunchAt)}</b></p><p><span>Reported by</span><b>{snapshot.firstPunchBy || "—"}</b></p><p><span>Variance</span><b className={openingIsLate ? "late" : ""}>{durationText(snapshot.openingLateMinutes)}</b></p><p><span>Opening schedule</span><b>{snapshot.openingShiftName || "Not linked"}</b></p><p><span>Source</span><b>{snapshot.openingShiftSource || "No approved station roster"}</b></p><p><span>Opening punch window</span><b>{snapshot.openingWindowStart.slice(0, 5)}–{snapshot.openingWindowEnd.slice(0, 5)}</b></p></div></details>
          <article><span>Metric health</span><strong>{metrics.length - misses.length}/{metrics.length}</strong><small>Within configured range</small></article>
        </div>
        {previousReview ? <div className="performance-previous-takeaway"><span><strong>Previous review · {formatDashboardDate(previousReview.source_date)}</strong><small>{previousReview.status === "closed" ? "Completed" : "Carried forward"}</small></span><p>{previousReview.review_summary || "No takeaway was recorded."}</p></div> : null}
        {carriedActions.length ? <details className="performance-inline-detail carried-review-actions" open><summary><span>Open actions from earlier reviews</span><b>{carriedActions.length} carried</b></summary><div>{carriedActions.map((item) => <article key={item.id}><span><strong>{item.metric_label}</strong><small>{item.root_cause || "RCA pending"}</small></span><span><b>{item.corrective_action || "Action pending"}</b><small>{item.action_owner || "Owner pending"}{item.due_date ? ` · due ${formatDashboardDate(item.due_date)}` : ""}</small></span><em>{item.status.replace("_", " ")}</em></article>)}</div></details> : null}
        <details className="performance-inline-detail" open>
          <summary><span>Performance scorecard</span><b>{metrics.length} metrics</b></summary>
          <div className="performance-review-metrics">{metrics.map((metric) => <article className={metric.severity} key={metric.key}><span title={metric.label}>{metric.short}</span><strong>{valueText(metric.actual)}</strong><small>{metric.target == null ? "Reference metric" : `Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}</small></article>)}</div>
        </details>
        {review && canEdit ? <ReviewActionForm action={savePerformanceReviewOperations} className="performance-operations-form">
          <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/>
          <input type="hidden" name="review_version" value={review.updated_at}/>
          <label className="wide">Review takeaway<textarea name="review_summary" defaultValue={review.review_summary ?? ""} placeholder="Only the key conclusion or escalation"/></label>
          <button className="button secondary">Save takeaway</button>
        </ReviewActionForm> : review ? <div className="review-takeaway-readonly"><strong>Review takeaway</strong><p>{review.review_summary || "Awaiting the first manager’s review."}</p></div> : null}
        {review && misses.length ? <div className="performance-review-actions"><h3>RCA and next-day actions</h3>{misses.map((metric) => {
          const item = itemByMetric.get(metric.key);
          return <details className="performance-action-item" key={`action-${metric.key}`} open={Boolean(item && item.status !== "done")}><summary><span className={`metric-dot ${metric.severity}`}/><strong>{metric.label}</strong><b>{item?.status?.replace("_", " ") || "Needs RCA"}</b></summary>{canEdit ? <ReviewActionForm action={savePerformanceReviewItem}>
            <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="review_version" value={review.updated_at}/><input type="hidden" name="metric_key" value={metric.key}/><input type="hidden" name="metric_label" value={metric.label}/><input type="hidden" name="actual_value" value={metric.actual ?? ""}/><input type="hidden" name="target_value" value={metric.target ?? ""}/><input type="hidden" name="target_direction" value={metric.direction}/><input type="hidden" name="severity" value={metric.severity}/>
            <label>Root cause<textarea required name="root_cause" defaultValue={item?.root_cause ?? ""} placeholder="What caused the miss?"/></label>
            <label>Next action<textarea required name="corrective_action" defaultValue={item?.corrective_action ?? ""} placeholder="Specific action before next review"/></label>
            <label>Owner<input required name="action_owner" defaultValue={item?.action_owner ?? ""}/></label><label>Due<input type="date" name="due_date" defaultValue={item?.due_date ?? date}/></label><label>Status<select name="status" defaultValue={item?.status ?? "open"}><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label><button className="button secondary">Save action</button>
          </ReviewActionForm> : <div className="performance-action-readonly"><p><b>RCA</b>{item?.root_cause || "Awaiting update"}</p><p><b>Action</b>{item?.corrective_action || "Awaiting update"}</p><p><b>Owner / due</b>{item?.action_owner || "—"}{item?.due_date ? ` · ${formatDashboardDate(item.due_date)}` : ""}</p></div>}</details>;
        })}</div> : null}
      </section>

      <section className="panel performance-review-section performance-cps-review">
        <div className="panel-head"><div><span className="performance-review-kicker">02 · CPS</span><h2>Cost and allocation</h2><p className="subtle">Click any cost card to see its contributing lines and approvals here.</p></div></div>
        <div className="performance-cps-cards">
          <details><summary><span>Salary DA CPS</span><strong>{money(snapshot.salaryDaCps)}</strong><small>{money(snapshot.salaryDaCost)} total</small></summary><div><p><span>Per-shipment / variable</span><b>{money(snapshot.variableDaPay)}</b></p><p><span>MG / salary</span><b>{money(snapshot.mgSalaryPay)}</b></p><p><span>Kilometre / fuel</span><b>{money(snapshot.fuelPay)}</b></p><p><span>FE payment setup gaps</span><b>{snapshot.unmappedFeCount}</b></p></div></details>
          <details><summary><span>Ad-hoc van · info</span><strong>{money(snapshot.adHocVanCost)}</strong><small>{snapshot.adHocVanRequests.length} approved request{snapshot.adHocVanRequests.length === 1 ? "" : "s"} · click for reason</small></summary><div>{snapshot.adHocVanRequests.length ? snapshot.adHocVanRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}<small>{request.reason}</small></span><b>{money(request.amount)}</b></p>) : <p><span>No approved ad-hoc van request</span><b>₹0</b></p>}</div></details>
          <details><summary><span>Ad-hoc DA · info</span><strong>{money(snapshot.adHocDaCost)}</strong><small>{snapshot.adHocDaRequests.length} approved request{snapshot.adHocDaRequests.length === 1 ? "" : "s"} · click for reason</small></summary><div>{snapshot.adHocDaRequests.length ? snapshot.adHocDaRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}<small>{request.reason}</small></span><b>{money(request.amount)}</b></p>) : <p><span>No approved ad-hoc DA request</span><b>₹0</b></p>}</div></details>
          <details><summary><span>Daily CPS</span><strong>{money(snapshot.dailyCps)}</strong><small>{money(snapshot.dayCost)} total cost</small></summary><div>{snapshot.costBreakdown.length ? snapshot.costBreakdown.map((line, index) => <p key={`${line.head}-${line.subHead}-${index}`}><span>{line.head} · {line.subHead}<small>{line.source}</small></span><b>{money(line.amount)}<small>{money(line.cps)} CPS</small></b></p>) : <p><span>No cost breakup loaded</span><b>—</b></p>}</div></details>
          <details><summary><span>MTD CPS</span><strong>{money(snapshot.mtdCps)}</strong><small>{money(snapshot.mtdCost)} / {snapshot.mtdDelivery.toLocaleString("en-IN")} delivered</small></summary><div><p><span>Month-to-date cost</span><b>{money(snapshot.mtdCost)}</b></p><p><span>Month-to-date delivery</span><b>{snapshot.mtdDelivery.toLocaleString("en-IN")}</b></p><p><span>Includes configured DA, UTR, van, fuel, rent and other heads</span><b>All heads</b></p></div></details>
          <details><summary><span>Allocation</span><strong>{snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)}</strong><small>{snapshot.deliveredCount.toLocaleString("en-IN")} deliveries / {snapshot.activeFeCount} FEs</small></summary><div><p><span>Delivered shipments</span><b>{snapshot.deliveredCount.toLocaleString("en-IN")}</b></p><p><span>Active FE IDs</span><b>{snapshot.activeFeCount}</b></p></div></details>
        </div>
        <div className="performance-cps-note"><strong>Cost completeness</strong><span>Values appear only when their source is loaded or configured. Missing rent, UTR or payment mappings remain visible as a data gap; OpsPulse does not estimate them.</span><Link href="/cps/inputs">Open CPS inputs →</Link></div>
      </section>
    </div>

    {review ? <section className="review-discussion">
      <header><div><h3>Review discussion</h3><p>{review.status === "closed" ? "Review completed · all inputs remain visible" : activeStep ? `With ${activeStep.reviewer_name} · ${activeStep.reviewer_role}` : "Review manager not assigned"}</p></div><span>{reviewUpdates.length} updates</span></header>
      {canComment || canCompleteStep ? <ReviewActionForm action={savePerformanceReviewComment} className="review-comment-form" resetOnSuccess>
        <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="step_id" value={activeStep?.id ?? ""}/>
        <label>Your review input<textarea name="feedback" maxLength={4000} placeholder="Add context, feedback or the next follow-up…" rows={2}/></label>
        <div className="review-comment-buttons">{canComment ? <button className="button secondary" name="intent" value="comment">Save comment</button> : null}{canCompleteStep ? <button className="button" name="intent" value="complete">Complete my review →</button> : null}</div>
      </ReviewActionForm> : <p className="review-empty">All comments are visible here. Only the assigned manager can complete the current stage.</p>}
      <div className="review-comment-feed">{reviewUpdates.length ? reviewUpdates.map(update=><article key={update.id}>
        <header><strong>{update.author_name || "Recorded update"}</strong><span>{update.author_role || update.stage_label || "Review"}</span><time dateTime={update.created_at}>{new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(update.created_at))}</time></header>
        <p>{update.note}</p>
      </article>) : <p className="review-empty">No comments yet.</p>}</div>
    </section> : null}
  </div>;
}
