"use client";

import { formatDashboardDate } from "@/lib/date-format";
import type { PerformanceReviewItem } from "@/lib/ops-pulse/performance-review";
import { savePerformanceDisciplineReason, savePerformanceReviewItem } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { DISCIPLINE_REASON_MAX } from "@/lib/ops-pulse/review-discipline-rca";

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
  stationCode
}: Props) {
  if (!rows.length) return null;

  return (
    <div className="performance-review-actions" id="review-rca">
      <h3>RCA and next-day actions</h3>
      {rows.some(row => row.reasonOnly) ? <p className="review-rca-hint">Opening and UTR delays need just one short reason each. No long write-up.</p> : null}
      {rows.map((metric) => {
        const item = itemsByMetric.get(metric.key);
        return (
          <details className="performance-action-item" key={`action-${metric.key}`}>
            <summary>
              <span className={`metric-dot ${metric.severity}`} />
              <strong>{metric.label}</strong>
              {metric.reasonOnly ? <small>{metric.actual == null ? "Recorded delay" : `${metric.actual} min late`}</small> : <small>
                Actual {valueText(metric.actual)}
                {metric.target == null ? "" : ` · Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}
              </small>}
              <b>{metric.reasonOnly ? item?.root_cause?.trim() ? "Reason saved" : "Reason required" : item?.status?.replaceAll("_", " ") || "Needs RCA"}</b>
            </summary>
            {metric.reasonOnly ? <div className="review-delay-detail">
              <p className="review-delay-evidence">{metric.evidence}</p>
              {canEditDiscipline && activeDisciplineKeys.includes(metric.key) ? <ReviewActionForm action={savePerformanceDisciplineReason} className="review-delay-form">
                <input type="hidden" name="review_id" value={reviewId} />
                <input type="hidden" name="source_date" value={date} />
                <input type="hidden" name="station_code" value={stationCode} />
                <input type="hidden" name="metric_key" value={metric.key} />
                <label>Reason for delay<input required name="root_cause" maxLength={DISCIPLINE_REASON_MAX} defaultValue={item?.root_cause ?? ""} placeholder="Brief reason, e.g. transport delay" /></label>
                <button className="button secondary">Save reason</button>
              </ReviewActionForm> : <p className="review-delay-saved"><b>Reason</b> {item?.root_cause || "Awaiting a short reason from the reviewer."}</p>}
            </div> : canEdit ? (
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
                <p><b>RCA</b>{item?.root_cause || "Awaiting update"}</p>
                <p><b>Action</b>{item?.corrective_action || "Awaiting update"}</p>
                <p><b>Owner / due</b>{item?.action_owner || "—"}{item?.due_date ? ` · ${formatDashboardDate(item.due_date)}` : ""}</p>
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}
