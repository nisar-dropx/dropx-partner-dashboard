"use client";

import { Fragment, type ReactNode } from "react";
import { formatDashboardDate } from "@/lib/date-format";
import type { PerformanceReviewItem } from "@/lib/ops-pulse/performance-review";
import { savePerformanceDisciplineReason, savePerformanceReviewItem } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { DISCIPLINE_REASON_MAX } from "@/lib/ops-pulse/review-discipline-rca";
import { ReviewPersonHistoryLink } from "@/components/review-attendance-history";

type ReviewMetric = {
  actual: number | null;
  direction: "higher" | "lower";
  key: string;
  label: string;
  severity: "green" | "amber" | "red" | "neutral";
  target: number | null;
  reasonOnly?: boolean;
  evidence?: string;
};

type Props = {
  canEdit: boolean;
  canEditDiscipline: boolean;
  activeDisciplineKeys: string[];
  date: string;
  itemsByMetric: Map<string, PerformanceReviewItem>;
  rows: ReviewMetric[];
  reviewId: string;
  reviewVersion: string;
  stationCode: string;
  reviewStarted?: boolean;
  startControl?: ReactNode;
  editHint?: string;
};

function valueText(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function PerformanceRcaActions({
  canEdit,
  canEditDiscipline,
  activeDisciplineKeys,
  date,
  itemsByMetric,
  rows,
  reviewId,
  reviewVersion,
  stationCode,
  reviewStarted = true,
  startControl,
  editHint
}: Props) {
  if (!rows.length) return null;
  const orderedRows = [...rows.filter(row=>!row.reasonOnly), ...rows.filter(row=>row.reasonOnly)];
  const canSaveMetric = reviewStarted && canEdit;
  const canSaveReason = reviewStarted && canEditDiscipline;

  return (
    <div className="performance-review-actions" id="review-rca">
      <div className="review-rca-heading"><div><h3>RCA & reporting reasons</h3><p className="review-rca-hint">Performance misses: RCA and action plan. Opening / UTR delays: one short reason only.</p></div>{startControl}</div>
      {!reviewStarted ? <p className="review-rca-locked">The review has not started. The misses are listed below; start the review to save RCA and delay reasons.</p> : editHint ? <p className="review-rca-locked">{editHint}</p> : null}
      {orderedRows.map((metric,index) => {
        const item = itemsByMetric.get(metric.key);
        return (
          <Fragment key={`action-${metric.key}`}>
          {index===0 || Boolean(orderedRows[index-1].reasonOnly)!==Boolean(metric.reasonOnly) ? <h4 className="review-rca-group">{metric.reasonOnly ? "Opening & UTR delays · reason only" : "Performance misses · RCA & action plan"}</h4> : null}
          <details className="performance-action-item">
            <summary>
              <span className={`metric-dot ${metric.severity}`} />
              <strong>{metric.label}</strong>
              {metric.reasonOnly ? <small>{metric.actual == null ? "Recorded delay" : `${metric.actual} min late`}</small> : <small>
                Actual {valueText(metric.actual)}
                {metric.target == null ? "" : ` · Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}
              </small>}
              <b>{metric.reasonOnly ? item?.root_cause?.trim() ? "Reason saved" : "Reason required" : item?.status?.replaceAll("_", " ") || "Needs RCA"}<span className="review-rca-edit-label">{!reviewStarted ? "View miss ›" : metric.reasonOnly ? canSaveReason && activeDisciplineKeys.includes(metric.key) ? item?.root_cause?.trim() ? "Edit reason ›" : "Add reason ›" : "View reason ›" : canSaveMetric ? "Edit RCA & plan ›" : "View RCA ›"}</span></b>
            </summary>
            {metric.reasonOnly ? <div className="review-delay-detail">
              <p className="review-delay-evidence">{metric.evidence}</p>
              {metric.key.startsWith("utr_late_") ? <ReviewPersonHistoryLink personId={metric.key.replace(/^utr_late_(employee|contractor)_/, "$1:")}/> : null}
              {canSaveReason && activeDisciplineKeys.includes(metric.key) ? <ReviewActionForm action={savePerformanceDisciplineReason} className="review-delay-form">
                <input type="hidden" name="review_id" value={reviewId} />
                <input type="hidden" name="source_date" value={date} />
                <input type="hidden" name="station_code" value={stationCode} />
                <input type="hidden" name="metric_key" value={metric.key} />
                <label>Reason for delay<input required name="root_cause" maxLength={DISCIPLINE_REASON_MAX} defaultValue={item?.root_cause ?? ""} placeholder="Brief reason, e.g. transport delay" /></label>
                <button className="button secondary">Save reason</button>
              </ReviewActionForm> : <p className="review-delay-saved"><b>Reason</b> {item?.root_cause || (!reviewStarted ? "Start the review to add a short reason. No action plan is needed for this delay." : "Awaiting a short reason from the reviewer.")}</p>}
            </div> : canSaveMetric ? (
              <ReviewActionForm action={savePerformanceReviewItem} className="performance-rca-form">
                <input type="hidden" name="review_id" value={reviewId} />
                <input type="hidden" name="source_date" value={date} />
                <input type="hidden" name="station_code" value={stationCode} />
                <input type="hidden" name="review_version" value={reviewVersion} />
                <input type="hidden" name="metric_key" value={item?.metric_key || metric.key} />
                <input type="hidden" name="metric_label" value={metric.label} />
                <input type="hidden" name="actual_value" value={metric.actual ?? ""} />
                <input type="hidden" name="target_value" value={metric.target ?? ""} />
                <input type="hidden" name="target_direction" value={metric.direction} />
                <input type="hidden" name="severity" value={metric.severity === "amber" ? "amber" : "red"} />
                <label>
                  Root cause
                  <textarea required name="root_cause" defaultValue={item?.root_cause ?? ""} placeholder="What caused the miss?" />
                </label>
                <label>
                  Next action
                  <textarea required name="corrective_action" defaultValue={item?.corrective_action ?? ""} placeholder="Specific action before next review" />
                </label>
                <label>
                  Owner
                  <input required name="action_owner" defaultValue={item?.action_owner ?? ""} />
                </label>
                <label>
                  Due
                  <input type="date" name="due_date" defaultValue={item?.due_date ?? date} />
                </label>
                <label>
                  Status
                  <select name="status" defaultValue={item?.status ?? "open"}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="blocked">Blocked</option>
                    <option value="done">Done</option>
                  </select>
                </label>
                <button className="button secondary">Save action</button>
              </ReviewActionForm>
            ) : (
              <div className="performance-action-readonly">
                <p><b>RCA</b>{item?.root_cause || (!reviewStarted ? "Start the review to add RCA and an action plan." : "Awaiting update")}</p>
                <p><b>Action</b>{item?.corrective_action || "Awaiting update"}</p>
                <p><b>Owner / due</b>{item?.action_owner || "—"}{item?.due_date ? ` · ${formatDashboardDate(item.due_date)}` : ""}</p>
              </div>
            )}
          </details>
          </Fragment>
        );
      })}
    </div>
  );
}
