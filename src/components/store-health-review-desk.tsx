import Link from "next/link";
import { PerformanceReviewExceptions } from "@/components/performance-review-exceptions";
import { PerformanceReviewFlow } from "@/components/performance-review-flow";
import { PerformanceFollowups } from "@/components/performance-followups";
import { PerformanceRcaActions } from "@/components/performance-rca-actions";
import { PerformanceCarriedActions } from "@/components/performance-carried-actions";
import { PerformanceReviewPicker } from "@/components/performance-review-picker";
import { ReviewActionForm } from "@/components/review-action-form";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import { savePerformanceReviewComment, savePerformanceReviewOperations, startPerformanceReview } from "@/app/ops-pulse/performance/actions";
import { formatDashboardDate } from "@/lib/date-format";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type {
  PerformanceFollowup,
  PerformanceReview,
  PerformanceReviewBacklog,
  PerformanceReviewCarryover,
  PerformanceReviewChainStep,
  PerformanceReviewItem,
  PerformanceReviewStep,
  PerformanceReviewUpdate
} from "@/lib/ops-pulse/performance-review";
import { reviewLink } from "@/lib/ops-pulse/review-periods";
import { discussionFeedUpdates, visibleReviewStep } from "@/lib/ops-pulse/review-policy";
import {
  storeHealthBandTone,
  storeHealthMetricDefinitions,
  type StoreHealthHero,
  type StoreHealthReviewMetric
} from "@/lib/ops-pulse/store-health-scorecard";
import { StoreHealthScorecardPanel, type StoreHealthHistoryDay } from "@/components/store-health-scorecard-panel";
import "@/app/ops-pulse/performance/review-desk.css";
import "@/app/ops-pulse/performance/store-health-review.css";

export type { StoreHealthHero };

type Props = {
  canBypass: boolean;
  canProxy: boolean;
  canAccessBypass: boolean;
  canAccessProxy: boolean;
  canUndoBypass: boolean;
  canManageActions: boolean;
  reviewerEditReopened?: boolean;
  isOriginalReviewer?: boolean;
  stationLeads: string;
  backlog: PerformanceReviewBacklog;
  pendingExpanded: boolean;
  followups: { rows: PerformanceFollowup[]; count: number; error: string | null };
  canAdd: boolean;
  canCompleteStep: boolean;
  canEdit: boolean;
  canComment: boolean;
  programManager: boolean;
  updates: PerformanceReviewUpdate[];
  reviewChain: PerformanceReviewChainStep[];
  routingIssue: string | null;
  date: string;
  error: string | null;
  items: PerformanceReviewItem[];
  locations: CodLocationRow[];
  reviewClusters?: { value: string; label: string }[];
  selectedCluster?: string;
  canFilterClusters?: boolean;
  readOnlyPreview?: boolean;
  metrics: StoreHealthReviewMetric[];
  history: StoreHealthHistoryDay[];
  hero: StoreHealthHero;
  notice: string | null;
  previousReviews: PerformanceReviewCarryover[];
  review: PerformanceReview | null;
  reviews: PerformanceReview[];
  selectedLocation: CodLocationRow;
  sourceBatchId: string | null;
  sourceType: string;
  sourceWeek: number;
  steps: PerformanceReviewStep[];
};

function stationKey(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatActual(metric: StoreHealthReviewMetric) {
  if (metric.evidence) return metric.evidence;
  if (metric.severity === "neutral" && metric.actual == null) return "Not scored";
  if (metric.actual == null) return "—";
  return String(metric.actual);
}

export function StoreHealthReviewDesk(props: Props) {
  const {
    canAdd, canCompleteStep, canEdit, canComment, programManager, reviewerEditReopened, isOriginalReviewer,
    updates, reviewChain, date, error, items, locations, metrics, history, notice, previousReviews, review, reviews,
    selectedLocation, sourceBatchId, sourceType, sourceWeek, steps, hero
  } = props;
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
  const resolveItem = (metric: StoreHealthReviewMetric) => itemByMetric.get(metric.key) ?? itemByMetric.get(stationKey(metric.label)) ?? itemByMetric.get(metric.label);
  const carriedActions = selectedItems.filter((item) => item.review_id !== review?.id);
  const metricMisses = metrics.filter((metric) => metric.severity === "red" || metric.severity === "amber");
  const savedOnlyRows: StoreHealthReviewMetric[] = currentItems
    .filter((item) => {
      const linked = metricMisses.some((metric) => metric.key === item.metric_key || stationKey(metric.label) === stationKey(item.metric_label));
      return !linked && Boolean(item.root_cause || item.corrective_action);
    })
    .map((item) => {
      const fromScorecard = metrics.find((metric) => metric.key === item.metric_key || stationKey(metric.label) === stationKey(item.metric_label));
      return fromScorecard ?? {
        actual: item.actual_value == null ? null : Number(item.actual_value),
        direction: item.target_direction === "lower" ? "lower" : "higher",
        key: item.metric_key,
        label: item.metric_label,
        severity: (item.severity === "amber" ? "amber" : "red") as StoreHealthReviewMetric["severity"],
        short: item.metric_label,
        target: item.target_value == null ? null : Number(item.target_value)
      };
    });
  const rcaRows = [...metricMisses, ...savedOnlyRows].map((metric) => {
    const definition = storeHealthMetricDefinitions.find((entry) => entry.key === metric.key);
    const actual = metric.evidence?.trim() || formatActual(metric);
    const target = definition?.targetText ? ` · Target ${definition.targetText}` : "";
    return { ...metric, evidence: `${actual}${target}` };
  });
  const itemsByMetricForRca = new Map<string, PerformanceReviewItem>();
  for (const metric of rcaRows) {
    const item = resolveItem(metric);
    if (item) itemsByMetricForRca.set(metric.key, item);
  }
  const activeStep = review && !review.routing_error ? steps.find((step) => step.review_id === review.id && step.step_order === review.current_step_order) ?? null : null;
  const reviewByStation = new Map(reviews.map((entry) => [stationKey(entry.station_code), entry]));
  const completedCount = locations.filter((location) => reviewByStation.get(stationKey(location.station_code))?.status === "closed").length;
  const inReviewCount = locations.filter((location) => ["open", "in_review"].includes(reviewByStation.get(stationKey(location.station_code))?.status ?? "")).length;
  const notStartedCount = locations.length - completedCount - inReviewCount;
  const selectedSteps = (review
    ? steps.filter((step) => step.review_id === review.id && visibleReviewStep(step))
    : reviewChain.map((step, index) => ({
      id: `route-${index + 1}`,
      review_id: "",
      step_order: index + 1,
      reviewer_user_id: step.reviewerUserId,
      reviewer_name: step.reviewerName,
      reviewer_role: step.reviewerRole,
      routing_source: step.routingSource,
      status: "pending" as const,
      feedback: null,
      completed_at: null,
      bypass_reason: null,
      bypassed_at: null,
      bypassed_by_name: null,
      proxy_reviewer_user_id: null,
      proxy_reviewer_name: null,
      proxy_reason: null,
      proxy_started_at: null
    }))
  ).sort((a, b) => a.step_order - b.step_order);
  const reviewUpdates = discussionFeedUpdates(updates.filter((update) => update.review_id === review?.id));
  const bandTone = storeHealthBandTone(hero.band);
  const scoredCount = metrics.filter((metric) => metric.severity !== "neutral").length;

  return <div className="performance-review-desk store-health-review-desk">
    {notice ? <div className="performance-review-message success">{notice}</div> : null}
    {error ? <div className="performance-review-message error">{error}</div> : null}
    <section className="ops-control-strip performance-review-control">
      <div className="ops-context-summary"><span>Loaded performance date</span><strong>{formatDashboardDate(date)}</strong><small>{selectedCode} · {selectedLocation.station_name || hero.city || selectedLocation.city || "Store"}</small></div>
      <PerformanceReviewPicker
        date={date}
        locations={locations.map((location) => ({
          code: location.station_code,
          name: location.station_name || location.city || location.station_code
        }))}
        stationCode={selectedCode}
        clusters={props.reviewClusters ?? []}
        selectedCluster={props.selectedCluster ?? ""}
        canFilterClusters={Boolean(props.canFilterClusters)}
      />
    </section>

    <ReviewDetails className="performance-review-overview"><summary><span><strong>Store reviews · {formatDashboardDate(date)}</strong><small>Selected performance day only · {locations.length} permitted stores</small></span><span className="performance-review-overview-counts"><b>{completedCount} done</b><b>{inReviewCount} active</b><b>{notStartedCount} not started</b></span></summary><div>{locations.map((location) => {
      const entry = reviewByStation.get(stationKey(location.station_code));
      const current = entry ? steps.find((step) => step.review_id === entry.id && step.step_order === entry.current_step_order && step.status === "pending") : null;
      return <article key={location.id}><span><strong>{location.station_code}</strong><small>{formatDashboardDate(date)} · {location.station_name || location.city}</small></span><em className={entry?.status || "not-started"}>{entry?.status.replace("_", " ") || "Not started"}</em><p>{entry?.review_summary || "Takeaway pending"}{entry ? <small>Started {new Date(entry.started_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small> : null}</p><span><b>{current?.proxy_reviewer_name || current?.reviewer_name || "—"}</b><Link href={reviewLink(date, location.station_code)}>View review →</Link></span></article>;
    })}</div><ReviewDetailsClose label="Close store reviews"/></ReviewDetails>

    <ReviewDetails className="performance-review-overview review-earlier-pending" open={props.pendingExpanded}><summary><span><strong>Earlier pending reviews</strong><small>Before {formatDashboardDate(date)} · separate from the selected day</small></span><b>{props.backlog.count} pending</b></summary>
      {props.backlog.error ? <p role="alert">{props.backlog.error}</p> : <div>{props.backlog.rows.map((entry) => <article key={entry.id}><span><strong>{entry.station_code}</strong><small>Performance {formatDashboardDate(entry.source_date)}</small></span><em className="in_review">Pending</em><p>{entry.pending_role}<small>{entry.pending_name || "Manager not linked"}</small></p><span><small>Started {new Date(entry.started_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small><Link href={reviewLink(entry.source_date, entry.station_code)}>Review {formatDashboardDate(entry.source_date)} →</Link></span></article>)}{!props.backlog.count ? <p className="review-empty">No earlier pending reviews.</p> : null}</div>}
      {props.backlog.count > props.backlog.pageSize ? <nav className="review-backlog-pages">{props.backlog.page > 1 ? <Link href={reviewLink(date, selectedCode, props.backlog.page - 1)}>← Previous</Link> : null}<span>Page {props.backlog.page} of {Math.ceil(props.backlog.count / props.backlog.pageSize)}</span>{props.backlog.page * props.backlog.pageSize < props.backlog.count ? <Link href={reviewLink(date, selectedCode, props.backlog.page + 1)}>Next →</Link> : null}</nav> : null}
      <ReviewDetailsClose label="Close earlier pending reviews"/>
    </ReviewDetails>

    <section className="performance-review-statusbar">
      <div><span>Source</span><strong>Store Health D-2</strong></div>
      <div><span>Review</span><strong>{review ? review.status.replace("_", " ") : "Not started"}</strong></div>
      <div><span>Current dependency</span><strong>{activeStep ? `${activeStep.reviewer_role} · ${activeStep.proxy_reviewer_name || activeStep.reviewer_name}${activeStep.proxy_reviewer_name ? " (proxy)" : ""}` : review?.status === "closed" ? "Completed" : "Start review"}</strong></div>
      <div><span>Health band</span><strong className={`store-health-band ${bandTone}`}>{hero.band ?? "—"}</strong></div>
      <div><span>Overall score</span><strong>{hero.scorePct == null ? "—" : `${hero.scorePct}%`}</strong></div>
      {!review && canAdd ? <ReviewActionForm action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button id="start-station-review" className="button">Start review</button></ReviewActionForm> : null}
    </section>

    {props.readOnlyPreview && !review ? <div className="alert warning" role="status">Read-only user preview hides Start review. Exit preview and open Review Desk as this user, or have them sign in, to start the review.</div> : null}
    {!review && !canAdd && !props.readOnlyPreview && reviewChain.length ? <div className="alert warning" role="status">Only the first review manager on this route ({reviewChain[0]?.reviewerRole} · {reviewChain[0]?.reviewerName}) or Program Manager can start this review.</div> : null}
    {!review && metricMisses.length ? <div className="performance-review-start-guide"><strong>{metricMisses.length} exceptions need RCA</strong><span>{canAdd ? "Use Start review above, then record RCA below." : "Start review becomes available once the assigned manager opens this store."}</span></div> : null}
    {review && !reviewUpdates.length && !currentItems.length ? <div className="performance-review-start-guide"><strong>Review started · no inputs saved yet</strong><span>This store is in review, but no RCA, takeaway or discussion has been saved. Add them below, or use Proxy / Skip if you are covering the assigned manager.</span></div> : null}
    {props.routingIssue ? <div className="alert warning" role="status">{props.routingIssue}</div> : null}

    {review ? <PerformanceReviewFlow key={`${review.id}-${review.current_step_order}-${review.updated_at}`} steps={selectedSteps} currentOrder={review.current_step_order} stationLeads={props.stationLeads}/> : <section className="performance-review-flow" aria-label="Review workflow">
      {reviewChain.map((step, index) => <div key={`${step.reviewerUserId}-${index}`}><i>{index + 1}</i><span>{step.reviewerRole}<small>{step.reviewerName}</small><small>Reviews with {index > 0 ? reviewChain[index - 1].reviewerName : props.stationLeads}</small></span></div>)}
    </section>}
    <p className="review-access-hint">{programManager ? "Program Manager · edit and comment at any stage" : isOriginalReviewer && reviewerEditReopened ? "Edit access reopened by oversight · you can update RCA, actions and takeaway again" : canEdit ? "Your review · update RCA, actions and takeaway" : canComment ? "Your review · add comments and complete your stage" : "View the full review · comments open at your review stage"}</p>
    <PerformanceReviewExceptions key={`${selectedCode}-${date}-${review?.updated_at ?? "not-started"}`} review={review} steps={selectedSteps} canBypass={props.canBypass} canProxy={props.canProxy} canAccessBypass={props.canAccessBypass} canAccessProxy={props.canAccessProxy} canUndoBypass={props.canUndoBypass} canStart={canAdd} hasRoute={Boolean(review || reviewChain.length)} routeLabel={reviewChain.map((step) => `${step.reviewerRole} · ${step.reviewerName}`).join(" → ") || selectedSteps.map((step) => `${step.reviewer_role} · ${step.reviewer_name}`).join(" → ")} reviewerEditReopened={Boolean(reviewerEditReopened)} firstReviewerName={reviewChain[0]?.reviewerName ?? selectedSteps.find((step) => visibleReviewStep(step))?.reviewer_name ?? null} darkStore/>

    <nav className="review-section-nav" aria-label="Jump to review section"><a href="#review-performance">Overview</a>{rcaRows.length ? <a href="#review-rca">RCA & reasons <b>{rcaRows.length}</b></a> : null}<a href="#review-followups">Actions</a>{review ? <a href="#review-discussion">Discussion</a> : null}</nav>

    <section className="panel performance-review-section" id="review-performance">
      <div className="panel-head"><div><span className="performance-review-kicker">01 · PERFORMANCE</span><h2>Store performance</h2><p className="subtle">Imported Store Health Scorecard metrics and action ownership in one review.</p></div><strong className={metricMisses.length ? "review-risk" : "review-good"}>{metricMisses.length} exception{metricMisses.length === 1 ? "" : "s"}</strong></div>

      <div className="performance-review-facts">
        <article className={bandTone ? `store-health-fact-${bandTone}` : undefined}><span>Overall score</span><strong>{hero.scorePct == null ? "—" : `${hero.scorePct}%`}</strong><small className={`store-health-band ${bandTone}`}>{hero.band ?? "No score"}</small></article>
        <article><span>Points earned</span><strong>{hero.pointsEarned == null || hero.pointsAvailable == null ? "—" : `${hero.pointsEarned} / ${hero.pointsAvailable}`}</strong><small>Earned / available after unscored removal</small></article>
        <article><span>Metric health</span><strong>{scoredCount ? `${scoredCount - metricMisses.length}/${scoredCount}` : "—"}</strong><small>{scoredCount} scored · {metrics.length} total fields</small></article>
        <article className={metricMisses.length ? "store-health-fact-amber" : "store-health-fact-green"}><span>Exceptions</span><strong>{metricMisses.length}</strong><small>Amber or red metrics needing RCA</small></article>
      </div>

      {hero.storeInsight || hero.networkInsight ? <details className="store-health-insights">
        <summary>
          Store & network notes
          <small>{[hero.storeInsight && "This store", hero.networkInsight && "Network"].filter(Boolean).join(" · ")}</small>
        </summary>
        <div className="store-health-insight-body">
          {hero.storeInsight ? <p><strong>This store</strong>{hero.storeInsight}</p> : null}
          {hero.networkInsight ? <p><strong>Network</strong>{hero.networkInsight}</p> : null}
        </div>
      </details> : null}

      {previousReview?.review_summary ? (
        <div className="performance-previous-takeaway">
          <span>
            <strong>Previous review · {formatDashboardDate(previousReview.source_date)}</strong>
            <small>{previousReview.status === "closed" ? "Completed" : "Carried forward"}</small>
          </span>
          <p>{previousReview.review_summary}</p>
        </div>
      ) : null}

      <StoreHealthScorecardPanel metrics={metrics} history={history} date={date}/>

      {rcaRows.length ? (
        <PerformanceRcaActions
          key={review?.id ?? `${selectedCode}-${date}-not-started`}
          canEdit={canEdit}
          canEditDiscipline={false}
          activeDisciplineKeys={[]}
          date={date}
          itemsByMetric={itemsByMetricForRca}
          rows={rcaRows}
          reviewId={review?.id ?? ""}
          reviewVersion={review?.updated_at ?? ""}
          stationCode={selectedCode}
          reviewStarted={Boolean(review)}
          hint="Amber and red Store Health metrics need RCA and a next action before the review can move on."
          startControl={!review && canAdd && !props.readOnlyPreview ? <ReviewActionForm action={startPerformanceReview}><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="source_type" value={sourceType}/><input type="hidden" name="source_batch_id" value={sourceBatchId ?? ""}/><input type="hidden" name="report_week" value={sourceWeek}/><button className="button">Start review & add RCA</button></ReviewActionForm> : undefined}
          editHint={!canEdit ? canCompleteStep ? "Performance RCA is editable by the first-stage reviewer or authorised oversight." : "View only at this stage. The assigned reviewer or authorised oversight can update these entries." : undefined}
        />
      ) : null}

      <PerformanceCarriedActions items={carriedActions} previous={previousStationReviews} review={review} canUpdate={props.canManageActions} selectedDate={date}/>
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

    <PerformanceFollowups key={`${selectedCode}-${date}`} review={review} date={date} rows={props.followups.rows} count={props.followups.count} error={props.followups.error} canAdd={canEdit} canUpdate={props.canManageActions}/>

    {review ? <section className="review-discussion" id="review-discussion">
      <header><div><h3>Review discussion</h3><p>{review.status === "closed" ? "Review completed · all inputs remain visible" : activeStep ? `${activeStep.proxy_reviewer_name || activeStep.reviewer_name} reviews with ${selectedSteps.findIndex((step) => step.id === activeStep.id) > 0 ? selectedSteps[selectedSteps.findIndex((step) => step.id === activeStep.id) - 1].reviewer_name : props.stationLeads}` : "Review manager not assigned"}</p></div><span>{reviewUpdates.length} updates</span></header>
      {canComment || canCompleteStep ? <ReviewActionForm key={review.id} action={savePerformanceReviewComment} className="review-comment-form" resetOnSuccess>
        <input type="hidden" name="review_id" value={review.id}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={selectedCode}/><input type="hidden" name="step_id" value={activeStep?.id ?? ""}/>
        <label>Your review input<textarea name="feedback" maxLength={4000} placeholder="Add context, feedback or the next follow-up…" rows={2}/></label>
        <div className="review-comment-buttons">{canComment ? <button className="button secondary" name="intent" value="comment">Save comment</button> : null}{canCompleteStep ? <button className="button" name="intent" value="complete">Complete my review →</button> : null}</div>
      </ReviewActionForm> : <p className="review-empty">All comments are visible here. Only the assigned manager can complete the current stage.</p>}
      <div className="review-comment-feed">{reviewUpdates.length ? reviewUpdates.map((update) => <article key={update.id}>
        <header><strong>{update.author_name || "Recorded update"}</strong><span>{update.author_role || update.stage_label || "Review"}</span><time dateTime={update.created_at}>{new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(update.created_at))}</time></header>
        <>{update.stage_label === "People routing" ? <details><summary>People mapping update · view details</summary><p>{update.note}</p></details> : <p>{update.note}</p>}</>
      </article>) : <p className="review-empty">No comments yet.</p>}</div>
    </section> : null}
  </div>;
}
