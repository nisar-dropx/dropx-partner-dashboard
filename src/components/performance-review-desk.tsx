import { PerformanceCarriedActions } from "@/components/performance-carried-actions";
import {PerformanceTrendProvider,TrendButton} from "@/components/performance-trends";
import { PerformanceVanFuel } from "@/components/performance-van-fuel";
import "@/app/ops-pulse/performance/review-trends.css";
import { PerformanceReviewExceptions } from "@/components/performance-review-exceptions";
import { PerformanceReviewFlow } from "@/components/performance-review-flow";
import type { StationReviewTargets } from "@/lib/ops-pulse/station-review-targets";
import { PerformanceNoonEmdEntry } from "@/components/performance-noon-emd";
import { PerformanceCodPending } from "@/components/performance-cod-pending";
import type { ReviewCodSnapshot } from "@/lib/ops-pulse/review-cod";
import Link from "next/link";
import { PerformanceFollowups } from "@/components/performance-followups";
import type { PerformanceReviewBacklog, PerformanceFollowup, PerformanceNoonEmd } from "@/lib/ops-pulse/performance-review";
import { reviewLink } from "@/lib/ops-pulse/review-periods";
import { PerformanceOpeningCard } from "@/components/performance-opening-card";
import { formatDashboardDate } from "@/lib/date-format";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { PerformanceAssociateDelivery, PerformanceOperationalSnapshot, PerformanceReview, PerformanceReviewCarryover, PerformanceReviewItem, PerformanceReviewStep, PerformanceConnection, PerformanceReviewUpdate, PerformanceReviewChainStep } from "@/lib/ops-pulse/performance-review";
import { savePerformanceReviewComment, savePerformanceReviewOperations, startPerformanceReview } from "@/app/ops-pulse/performance/actions";
import { PerformanceReviewPicker } from "@/components/performance-review-picker";
import { PerformanceConnections } from "@/components/performance-connections";
import { PerformanceRcaActions } from "@/components/performance-rca-actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { discussionFeedUpdates, visibleReviewStep } from "@/lib/ops-pulse/review-policy";
import type { ReactNode } from "react";

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
  codSnapshot: ReviewCodSnapshot;
  canBypass: boolean;
  canProxy: boolean;
  canAccessBypass: boolean;
  canAccessProxy: boolean;
  canManageActions: boolean;
  stationLeads: string;
  backlog: PerformanceReviewBacklog;
  pendingExpanded: boolean;
  previousDay: string;
  followups: {rows:PerformanceFollowup[];count:number;error:string|null};
  stationTargets: StationReviewTargets;
  stationTargetsError: string|null;
  noonEmd: {row:PerformanceNoonEmd|null;error:string|null};
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

function stationKey(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function valueText(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function CostTrendCard({ metric, label, value, summary, children }: { metric: string; label: string; value: string; summary: string; children: ReactNode }) {
  return <article className="performance-cps-card">
    <div className="performance-cps-card-body">
      <span>{label}</span><strong>{value}</strong><small>{summary}</small>
      <TrendButton group="cost" metric={metric} label={label} variant="card"/>
    </div>
    <details>
      <summary aria-label={`View ${label} details`} title={`View ${label} details`}>i</summary>
      <div>{children}</div>
    </details>
  </article>;
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
  const selectedStationKey = stationKey(selectedCode);
  const previousStationReviews = previousReviews.filter((entry) => stationKey(entry.station_code) === selectedStationKey);
  const previousReview = previousStationReviews[0] ?? null;
  const selectedReviewIds = new Set([review?.id, ...previousStationReviews.map((entry) => entry.id)].filter(Boolean));
  const selectedItems = items.filter((item) => selectedReviewIds.has(item.review_id));
  const currentItems = selectedItems.filter((item) => item.review_id === review?.id);
  const itemByMetric = new Map<string, PerformanceReviewItem>();
  for (const item of currentItems) {
    itemByMetric.set(item.metric_key, item);
    const labelKey = stationKey(item.metric_label);
    if (labelKey && !itemByMetric.has(labelKey)) itemByMetric.set(labelKey, item);
  }
  const resolveItem = (metric: ReviewMetric) => itemByMetric.get(metric.key) ?? itemByMetric.get(stationKey(metric.label)) ?? itemByMetric.get(metric.label);
  const carriedActions = selectedItems.filter((item) => item.review_id !== review?.id);
  const misses = metrics.filter((metric) => metric.severity === "red" || metric.severity === "amber");
  // Saved RCA must remain visible even when a later source refresh makes its metric green or unavailable.
  const savedOnlyRows: ReviewMetric[] = currentItems
    .filter((item) => {
      const linkedToMiss = misses.some((metric) => metric.key === item.metric_key || stationKey(metric.label) === stationKey(item.metric_label));
      return !linkedToMiss && Boolean(item.root_cause || item.corrective_action);
    })
    .map((item) => {
      const fromScorecard = metrics.find((metric) => metric.key === item.metric_key || stationKey(metric.label) === stationKey(item.metric_label));
      return fromScorecard ?? {
        actual: item.actual_value == null ? null : Number(item.actual_value),
        direction: item.target_direction === "lower" ? "lower" : "higher",
        key: item.metric_key,
        label: item.metric_label,
        severity: (item.severity === "amber" ? "amber" : "red") as ReviewMetric["severity"],
        short: item.metric_label,
        target: item.target_value == null ? null : Number(item.target_value)
      };
    });
  const rcaRows = [...misses, ...savedOnlyRows];
  const itemsByMetricForRca = new Map<string, PerformanceReviewItem>();
  for (const metric of rcaRows) {
    const item = resolveItem(metric);
    if (item) itemsByMetricForRca.set(metric.key, item);
  }
  const activeStep = review ? steps.find((step) => step.review_id === review.id && step.step_order === review.current_step_order) ?? null : null;
  const reviewByStation = new Map(reviews.map((entry) => [stationKey(entry.station_code), entry]));
  const completedCount = locations.filter((location) => reviewByStation.get(stationKey(location.station_code))?.status === "closed").length;
  const inReviewCount = locations.filter((location) => ["open", "in_review"].includes(reviewByStation.get(stationKey(location.station_code))?.status ?? "")).length;
  const notStartedCount = locations.length - completedCount - inReviewCount;
  const selectedSteps = steps.filter((step) => step.review_id === review?.id && visibleReviewStep(step)).sort((a,b)=>a.step_order-b.step_order);
  const reviewUpdates = discussionFeedUpdates(updates.filter((update) => update.review_id === review?.id));
  return <PerformanceTrendProvider key={`${selectedCode}-${date}`} station={selectedCode} date={date}><div className="performance-review-desk">
    {notice ? <div className="performance-review-message success">{notice}</div> : null}
    {error ? <div className="performance-review-message error">{error}</div> : null}
    <section className="ops-control-strip performance-review-control">
      <div className="ops-context-summary"><span>Loaded performance date</span><strong>{formatDashboardDate(date)}</strong><small>{selectedCode} · {selectedLocation.station_name || selectedLocation.city || "Station"}</small></div>
      <PerformanceReviewPicker
        date={date}
        locations={locations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code }))}
        stationCode={selectedCode}
      />
    </section>

    <details className="performance-review-overview"><summary><span><strong>Station reviews · {formatDashboardDate(date)}</strong><small>Selected performance day only · {locations.length} permitted stations</small></span><span className="performance-review-overview-counts"><b>{completedCount} done</b><b>{inReviewCount} active</b><b>{notStartedCount} not started</b></span></summary><div>{locations.map(location=>{
      const entry=reviewByStation.get(stationKey(location.station_code));
      const current=entry?steps.find(step=>step.review_id===entry.id&&step.step_order===entry.current_step_order&&step.status==="pending"):null;
      return <article key={location.id}><span><strong>{location.station_code}</strong><small>{formatDashboardDate(date)} · {location.station_name||location.city}</small></span><em className={entry?.status||"not-started"}>{entry?.status.replace("_"," ")||"Not started"}</em><p>{entry?.review_summary||"Takeaway pending"}{entry?<small>Started {new Date(entry.started_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</small>:null}</p><span><b>{current?.proxy_reviewer_name||current?.reviewer_name||"—"}</b><Link href={reviewLink(date,location.station_code)}>View review →</Link></span></article>;
    })}</div></details>
    <details className="performance-review-overview review-earlier-pending" open={props.pendingExpanded}><summary><span><strong>Earlier pending reviews</strong><small>Before {formatDashboardDate(date)} · separate from the selected day</small></span><b>{props.backlog.count} pending</b></summary>
      {props.backlog.error?<p role="alert">{props.backlog.error}</p>:<div>{props.backlog.rows.map(entry=><article key={entry.id}><span><strong>{entry.station_code}</strong><small>Performance {formatDashboardDate(entry.source_date)}</small></span><em className="in_review">Pending</em><p>{entry.pending_role}<small>{entry.pending_name||"Manager not linked"}</small></p><span><small>Started {new Date(entry.started_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</small><Link href={reviewLink(entry.source_date,entry.station_code)}>Review {formatDashboardDate(entry.source_date)} →</Link></span></article>)}{!props.backlog.count?<p className="review-empty">No earlier pending reviews.</p>:null}</div>}
      {props.backlog.count>props.backlog.pageSize?<nav className="review-backlog-pages">{props.backlog.page>1?<Link href={reviewLink(date,selectedCode,props.backlog.page-1)}>← Previous</Link>:null}<span>Page {props.backlog.page} of {Math.ceil(props.backlog.count/props.backlog.pageSize)}</span>{props.backlog.page*props.backlog.pageSize<props.backlog.count?<Link href={reviewLink(date,selectedCode,props.backlog.page+1)}>Next →</Link>:null}</nav>:null}
    </details>

    <section className="performance-review-statusbar">
      <div><span>Source</span><strong>{sourceType === "amazon_hawkeye_daily" ? "Hawkeye D-1" : sourceType === "daily_edsp_metrics" ? "Daily EDSP" : "Operational data"}</strong></div>
      <div><span>Review</span><strong>{review ? review.status.replace("_", " ") : "Not started"}</strong></div>
      <div><span>Current dependency</span><strong>{activeStep ? `${activeStep.reviewer_role} · ${activeStep.proxy_reviewer_name||activeStep.reviewer_name}${activeStep.proxy_reviewer_name?" (proxy)":""}` : review?.status === "closed" ? "Completed" : "Start review"}</strong></div>
      {!review && canAdd ? <ReviewActionForm action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button id="start-station-review" className="button">Start review</button></ReviewActionForm> : null}
    </section>

    {!review && misses.length ? <div className="performance-review-start-guide"><strong>{misses.length} metrics need RCA and action</strong><span>Use Start review above, then record RCA and action items below.</span></div> : null}
    {props.routingIssue ? <div className="alert warning" role="status">{props.routingIssue}</div> : null}

    {review ? <PerformanceReviewFlow key={`${review.id}-${review.current_step_order}-${review.updated_at}`} steps={selectedSteps} currentOrder={review.current_step_order} stationLeads={props.stationLeads}/> : <section className="performance-review-flow" aria-label="Review workflow">
      {reviewChain.map((step,index)=><div key={`${step.reviewerUserId}-${index}`}><i>{index+1}</i><span>{step.reviewerRole}<small>{step.reviewerName}</small><small>Reviews with {index>0?reviewChain[index-1].reviewerName:props.stationLeads}</small></span></div>)}
    </section>}
    <p className="review-access-hint">{programManager?"Program Manager · edit and comment at any stage":canEditConnections&&!canComment&&!canEdit?"Station access · update vehicle timings and noon EMD; view the full review":canEdit?"Your review · update RCA, actions, takeaway and station timings":canComment?"Your review · add comments and complete your stage":"View the full review · comments open at your review stage"}</p>
    <PerformanceReviewExceptions key={`${selectedCode}-${date}-${review?.updated_at??"not-started"}`} review={review} steps={selectedSteps} canBypass={props.canBypass} canProxy={props.canProxy} canAccessBypass={props.canAccessBypass} canAccessProxy={props.canAccessProxy} canStart={canAdd} hasRoute={Boolean(review||reviewChain.length)}/>

    <div className="performance-review-columns">
      <section className="panel performance-review-section">
        <div className="panel-head"><div><span className="performance-review-kicker">01 · PERFORMANCE</span><h2>D-1 station performance</h2><p className="subtle">Uploaded Amazon metrics, opening discipline and action ownership in one review.</p></div><div className="review-history-actions"><TrendButton group="performance" metric="metric_health" label="Performance"/><strong className={misses.length ? "review-risk" : "review-good"}>{misses.length} exception{misses.length === 1 ? "" : "s"}</strong></div></div>
        <div className="performance-review-facts">
          <details className="performance-fact-card" name="performance-review-fact"><summary><span>Delivered · view split</span><strong>{snapshot.deliveredCount.toLocaleString("en-IN")}</strong><small>{snapshot.associateDeliveries.length} delivering associate{snapshot.associateDeliveries.length === 1 ? "" : "s"}</small></summary><AssociateDeliveryBreakdown rows={snapshot.associateDeliveries} total={snapshot.deliveredCount}/></details>
          <details className="performance-fact-card" name="performance-review-fact"><summary><span>Average allocation · view split</span><strong>{snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)}</strong><small>{snapshot.deliveredCount.toLocaleString("en-IN")} deliveries / {snapshot.activeFeCount} active FEs</small></summary><AssociateDeliveryBreakdown rows={snapshot.associateDeliveries} total={snapshot.deliveredCount}/></details>
          <PerformanceOpeningCard snapshot={snapshot}/>
          <article><span>Metric health</span><strong>{metrics.length - misses.length}/{metrics.length}</strong><small>Within configured range</small></article>
        </div>
        {previousReview?.review_summary ? (
          <div className="performance-previous-takeaway">
            <span>
              <strong>Previous review · {formatDashboardDate(previousReview.source_date)}</strong>
              <small>{previousReview.status === "closed" ? "Completed" : "Carried forward"}</small>
            </span>
            <p>{previousReview.review_summary}</p>
          </div>
        ) : null}
        <PerformanceCarriedActions items={carriedActions} previous={previousStationReviews} review={review} canUpdate={props.canManageActions}/>
        <details className="performance-inline-detail" open>
          <summary><span>Performance scorecard</span><b>{metrics.length} metrics</b></summary>
          <p className="review-history-hint">Click any metric for daily values · 7 or 14 days</p><div className="performance-review-metrics">{metrics.map((metric) => <article className={metric.severity} key={metric.key}><span title={metric.label}>{metric.short}</span><strong>{valueText(metric.actual)}</strong><small>{metric.target == null ? "Reference metric" : `Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}</small><TrendButton group="performance" metric={metric.key} label={metric.short} variant="card"/></article>)}</div>
        </details>
        {props.stationTargetsError ? <p role="alert">{props.stationTargetsError}</p> : null}
        <div className="review-station-updates">
          <PerformanceConnections key={`${selectedCode}-${date}`} connections={connections} date={date} stationCode={selectedCode} canEdit={canEditConnections} clearanceCutoff={props.stationTargets.clearanceCutoff}/>
          <PerformanceNoonEmdEntry target={props.stationTargets.emdNoonTarget} entry={props.noonEmd.row} error={props.noonEmd.error} date={date} stationCode={selectedCode} canEdit={canEditConnections}/>
        </div>
        {review && rcaRows.length ? (
          <PerformanceRcaActions
            key={review.id}
            canEdit={canEdit}
            date={date}
            itemsByMetric={itemsByMetricForRca}
            rows={rcaRows}
            reviewId={review.id}
            reviewVersion={review.updated_at}
            stationCode={selectedCode}
          />
        ) : null}
        {review && canEdit ? (
          <ReviewActionForm key={`takeaway-${review.id}`} action={savePerformanceReviewOperations} className="performance-operations-form">
            <input type="hidden" name="review_id" value={review.id}/>
            <input type="hidden" name="source_date" value={date}/>
            <input type="hidden" name="station_code" value={selectedCode}/>
            <input type="hidden" name="review_version" value={review.updated_at}/>
            <label className="wide">Review takeaway<textarea name="review_summary" defaultValue={review.review_summary ?? ""} placeholder="Only the key conclusion or escalation"/></label>
            <button className="button secondary">Save takeaway</button>
          </ReviewActionForm>
        ) : review ? (
          <div className="review-takeaway-readonly">
            <strong>Review takeaway</strong>
            <p>{review.review_summary || "Awaiting the first manager’s review."}</p>
          </div>
        ) : null}
      </section>

      <section className="panel performance-review-section performance-cps-review">
        <PerformanceCodPending key={`${selectedCode}-${props.codSnapshot.batchId}`} snapshot={props.codSnapshot}/>
        <div className="panel-head"><div><span className="performance-review-kicker">02 · CPS</span><h2>Cost and allocation</h2><p className="subtle">Click a card for its 7-day, 14-day or MTD history. Use i for the selected-day details.</p></div></div>
        <div className="performance-cps-cards">
          <CostTrendCard metric="salary_da_cps" label="Salary DA CPS" value={money(snapshot.salaryDaCps)} summary={`${money(snapshot.salaryDaCost)} total`}><p><span>Per-shipment / variable</span><b>{money(snapshot.variableDaPay)}</b></p><p><span>MG / salary</span><b>{money(snapshot.mgSalaryPay)}</b></p><p><span>Kilometre / fuel</span><b>{money(snapshot.fuelPay)}</b></p><p><span>FE payment setup gaps</span><b>{snapshot.unmappedFeCount}</b></p></CostTrendCard>
          <CostTrendCard metric="ad_hoc_van" label="Ad-hoc van" value={money(snapshot.adHocVanCost)} summary={`${snapshot.adHocVanRequests.length} van${snapshot.adHocVanRequests.length === 1 ? "" : "s"} · ${snapshot.deliveredCount.toLocaleString("en-IN")} total delivered`}>
            {snapshot.adHocVanRequests.length ? snapshot.adHocVanRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}<small>{request.reason}</small></span><b>{money(request.amount)}</b></p>) : <p><span>No ad-hoc van recorded</span><b>₹0</b></p>}
          </CostTrendCard>
          <CostTrendCard metric="ad_hoc_da" label="Ad-hoc DA" value={money(snapshot.adHocDaCost)} summary={`${snapshot.adHocDaRequests.length} approved request${snapshot.adHocDaRequests.length === 1 ? "" : "s"}`}>
            {snapshot.adHocDaRequests.length ? snapshot.adHocDaRequests.map((request) => <p key={request.requestNo}><span>{request.requestNo} · {request.head}<small>{request.reason}</small></span><b>{money(request.amount)}</b></p>) : <p><span>No approved ad-hoc DA request</span><b>₹0</b></p>}
          </CostTrendCard>
          <CostTrendCard metric="daily_cps" label="Daily CPS" value={money(snapshot.dailyCps)} summary={`${money(snapshot.dayCost)} total cost`}>
            {snapshot.costBreakdown.length ? snapshot.costBreakdown.map((line, index) => <p key={`${line.head}-${line.subHead}-${index}`}><span>{line.head} · {line.subHead}<small>{line.source}</small></span><b>{money(line.amount)}<small>{money(line.cps)} CPS</small></b></p>) : <p><span>No cost breakup loaded</span><b>—</b></p>}
          </CostTrendCard>
          <CostTrendCard metric="mtd_cps" label="MTD CPS" value={money(snapshot.mtdCps)} summary={`${money(snapshot.mtdCost)} / ${snapshot.mtdDelivery.toLocaleString("en-IN")} delivered`}><p><span>Month-to-date cost</span><b>{money(snapshot.mtdCost)}</b></p><p><span>Month-to-date delivery</span><b>{snapshot.mtdDelivery.toLocaleString("en-IN")}</b></p><p><span>Includes configured DA, UTR, van, fuel, rent and other heads</span><b>All heads</b></p></CostTrendCard>
          <CostTrendCard metric="allocation" label="Allocation" value={snapshot.averageAllocation == null ? "—" : snapshot.averageAllocation.toFixed(1)} summary={`${snapshot.deliveredCount.toLocaleString("en-IN")} deliveries / ${snapshot.activeFeCount} FEs`}><p><span>Delivered shipments</span><b>{snapshot.deliveredCount.toLocaleString("en-IN")}</b></p><p><span>Active FE IDs</span><b>{snapshot.activeFeCount}</b></p></CostTrendCard>
        </div>
        <PerformanceVanFuel key={`fuel-${selectedCode}-${date}`} station={selectedCode} date={date}/>
        <div className="performance-cps-note"><strong>Cost completeness</strong><span>Values appear only when their source is loaded or configured. Missing rent, UTR or payment mappings remain visible as a data gap; OpsPulse does not estimate them.</span><Link href="/cps/inputs">Open CPS inputs →</Link></div>
      </section>
    </div>

    <PerformanceFollowups key={`${selectedCode}-${date}`} review={review} date={date} rows={props.followups.rows} count={props.followups.count} error={props.followups.error} canAdd={canEdit} canUpdate={props.canManageActions}/>
    {review ? <section className="review-discussion" id="review-discussion">
      <header><div><h3>Review discussion</h3><p>{review.status === "closed" ? "Review completed · all inputs remain visible" : activeStep ? `${activeStep.proxy_reviewer_name||activeStep.reviewer_name} reviews with ${selectedSteps.findIndex(step=>step.id===activeStep.id)>0?selectedSteps[selectedSteps.findIndex(step=>step.id===activeStep.id)-1].reviewer_name:props.stationLeads}` : "Review manager not assigned"}</p></div><span>{reviewUpdates.length} updates</span></header>
      {canComment || canCompleteStep ? <ReviewActionForm key={review.id} action={savePerformanceReviewComment} className="review-comment-form" resetOnSuccess>
        <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="step_id" value={activeStep?.id ?? ""}/>
        <label>Your review input<textarea name="feedback" maxLength={4000} placeholder="Add context, feedback or the next follow-up…" rows={2}/></label>
        <div className="review-comment-buttons">{canComment ? <button className="button secondary" name="intent" value="comment">Save comment</button> : null}{canCompleteStep ? <button className="button" name="intent" value="complete">Complete my review →</button> : null}</div>
      </ReviewActionForm> : <p className="review-empty">All comments are visible here. Only the assigned manager can complete the current stage.</p>}
      <div className="review-comment-feed">{reviewUpdates.length ? reviewUpdates.map(update=><article key={update.id}>
        <header><strong>{update.author_name || "Recorded update"}</strong><span>{update.author_role || update.stage_label || "Review"}</span><time dateTime={update.created_at}>{new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(update.created_at))}</time></header>
        <p>{update.note}</p>
      </article>) : <p className="review-empty">No comments yet.</p>}</div>
    </section> : null}
  </div></PerformanceTrendProvider>;
}
