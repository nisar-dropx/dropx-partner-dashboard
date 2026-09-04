"use client";

import { formatDashboardDate } from "@/lib/date-format";
import type { PerformanceReviewItem } from "@/lib/ops-pulse/performance-review";
import { savePerformanceReviewItem } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

type ReviewMetric = {
  actual: number | null;
  direction: "higher" | "lower";
  key: string;
  label: string;
  severity: "green" | "amber" | "red" | "neutral";
  target: number | null;
};

type Props = {
  canEdit: boolean;
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
  date,
  itemsByMetric,
  rows,
  reviewId,
  reviewVersion,
  stationCode
}: Props) {
  if (!rows.length) return null;

  return (
    <div className="performance-review-actions">
      <h3>RCA and next-day actions</h3>
      {rows.map((metric) => {
        const item = itemsByMetric.get(metric.key);
        return (
          <details className="performance-action-item" key={`action-${metric.key}`}>
            <summary>
              <span className={`metric-dot ${metric.severity}`} />
              <strong>{metric.label}</strong>
              <small>
                Actual {valueText(metric.actual)}
                {metric.target == null ? "" : ` · Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}
              </small>
              <b>{item?.status?.replaceAll("_", " ") || "Needs RCA"}</b>
            </summary>
            {canEdit ? (
              <ReviewActionForm action={savePerformanceReviewItem}>
                <input type="hidden" name="review_id" value={reviewId} />
                <input type="hidden" name="source_date" value={date} />
                <input type="hidden" name="station_code" value={stationCode} />
                <input type="hidden" name="review_version" value={reviewVersion} />
                <input type="hidden" name="metric_key" value={metric.key} />
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
