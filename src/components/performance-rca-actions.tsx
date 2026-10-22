"use client";

import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";

import { Fragment, type ReactNode } from "react";
import { formatDashboardDate } from "@/lib/date-format";
import type { PerformanceReviewItem } from "@/lib/ops-pulse/performance-review";
import { savePerformanceCodRemark, savePerformanceDisciplineReason, savePerformanceReviewItem } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { DISCIPLINE_REASON_MAX } from "@/lib/ops-pulse/review-discipline-rca";
import { codRemarkMoney, isCodRemarkKey } from "@/lib/ops-pulse/review-cod-rca";
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
  /** Store Health PDF category when variant is store-health. */
  category?: string;
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
  /** Override the default Opening / UTR / COD hint (e.g. Dark Store scorecard RCA). */
  hint?: string;
  /** Dark Store: group misses by Store Health PDF categories and use denser cards. */
  variant?: "default" | "store-health";
  /** Optional PDF category order for store-health grouping. */
  categoryOrder?: string[];
};

function categoryLabel(category: string) {
  return category
    .toLowerCase()
    .split(" ")
    .map((part) => (part === "&" ? "&" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function valueText(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function defaultGroup(row: ReviewMetric) {
  return isCodRemarkKey(row.key)
    ? "COD pending 2+ days · remark only"
    : row.reasonOnly
      ? "Opening & UTR delays · reason only"
      : "Performance misses · RCA & action plan";
}

function storeHealthGroup(row: ReviewMetric) {
  return categoryLabel(row.category?.trim() || "Other");
}

function orderStoreHealthRows(rows: ReviewMetric[], categoryOrder: string[]) {
  return [...rows].sort((left, right) => {
    const leftCategory = left.category?.trim() || "Other";
    const rightCategory = right.category?.trim() || "Other";
    const leftIndex = categoryOrder.indexOf(leftCategory);
    const rightIndex = categoryOrder.indexOf(rightCategory);
    const categoryDelta = (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    if (categoryDelta) return categoryDelta;
    const severityDelta = (left.severity === "red" ? 0 : 1) - (right.severity === "red" ? 0 : 1);
    if (severityDelta) return severityDelta;
    return left.label.localeCompare(right.label);
  });
}

function statusLabel(metric: ReviewMetric, item: PerformanceReviewItem | undefined, reviewStarted: boolean) {
  if (metric.reasonOnly) return item?.root_cause?.trim() ? "Reason saved" : "Reason required";
  if (item?.root_cause?.trim() && item?.corrective_action?.trim()) {
    return item.status?.replaceAll("_", " ") || "RCA saved";
  }
  if (!reviewStarted) return "Needs RCA";
  return item?.root_cause?.trim() ? "Action plan incomplete" : "Needs RCA";
}

function actionLabel(
  metric: ReviewMetric,
  item: PerformanceReviewItem | undefined,
  reviewStarted: boolean,
  canSaveMetric: boolean,
  canSaveReason: boolean,
  activeDisciplineKeys: string[],
  storeHealth: boolean
) {
  if (!reviewStarted) return storeHealth ? "Open miss" : "View miss";
  if (metric.reasonOnly) {
    if (!(canSaveReason && activeDisciplineKeys.includes(metric.key))) return "View reason";
    return item?.root_cause?.trim() ? "Edit reason" : "Add reason";
  }
  if (!canSaveMetric) return "View RCA";
  // Last Mile keeps the historic "Edit RCA & plan" label even before the first save.
  if (!storeHealth) return "Edit RCA & plan";
  return item?.root_cause?.trim() ? "Edit RCA & plan" : "Add RCA & plan";
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
  editHint,
  hint = "Performance misses: RCA and action plan. Opening / UTR delays and COD pending 2+ days: one short reason only.",
  variant = "default",
  categoryOrder = []
}: Props) {
  if (!rows.length) return null;
  const storeHealth = variant === "store-health";
  const orderedRows = storeHealth
    ? orderStoreHealthRows(rows, categoryOrder)
    : [...rows.filter((row) => !row.reasonOnly), ...rows.filter((row) => row.reasonOnly && !isCodRemarkKey(row.key)), ...rows.filter((row) => isCodRemarkKey(row.key))];
  const group = storeHealth ? storeHealthGroup : defaultGroup;
  const canSaveMetric = reviewStarted && canEdit;
  const canSaveReason = reviewStarted && canEditDiscipline;
  const performanceRows = orderedRows.filter((row) => !row.reasonOnly);
  const savedCount = performanceRows.filter((row) => {
    const item = itemsByMetric.get(row.key);
    return Boolean(item?.root_cause?.trim() && item?.corrective_action?.trim());
  }).length;
  const pendingCount = Math.max(performanceRows.length - savedCount, 0);

  return (
    <div className={`performance-review-actions${storeHealth ? " store-health-rca" : ""}`} id="review-rca">
      <div className="review-rca-heading">
        <div>
          <h3>{storeHealth ? "Performance misses · RCA & action plan" : "RCA & reporting reasons"}</h3>
          <p className="review-rca-hint">{hint}</p>
        </div>
        {startControl}
      </div>
      {storeHealth && performanceRows.length ? (
        <div className="store-health-rca-progress" aria-label="RCA completion">
          <div>
            <strong>{savedCount}/{performanceRows.length}</strong>
            <span>misses with RCA + next action</span>
          </div>
          <div className="store-health-rca-progress-track" aria-hidden="true">
            <i style={{ width: `${performanceRows.length ? Math.round((savedCount / performanceRows.length) * 100) : 0}%` }} />
          </div>
          <small>{pendingCount ? `${pendingCount} still need RCA` : "All listed misses have RCA and a next action"}</small>
        </div>
      ) : null}
      {!reviewStarted ? (
        <p className="review-rca-locked">
          {storeHealth
            ? "Review not started. Misses are listed by Store Health group below — start the review to save RCA and next actions."
            : "The review has not started. The misses are listed below; start the review to save RCA and delay reasons."}
        </p>
      ) : editHint ? (
        <p className="review-rca-locked">{editHint}</p>
      ) : null}
      {orderedRows.map((metric, index) => {
        const item = itemsByMetric.get(metric.key);
        const cod = isCodRemarkKey(metric.key);
        const groupLabel = group(metric);
        const showGroup = index === 0 || group(orderedRows[index - 1]) !== groupLabel;
        const status = statusLabel(metric, item, reviewStarted);
          const cta = actionLabel(metric, item, reviewStarted, canSaveMetric, canSaveReason, activeDisciplineKeys, storeHealth);
        const evidence = metric.reasonOnly
          ? cod
            ? metric.actual == null ? "Recorded COD pendency" : `${codRemarkMoney(metric.actual)} aged 2+ days`
            : metric.actual == null ? "Recorded delay" : `${metric.actual} min late`
          : storeHealth
            ? (metric.evidence?.trim() || valueText(metric.actual))
            : `Actual ${metric.evidence?.trim() || valueText(metric.actual)}${metric.target == null ? "" : ` · Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}`;
        return (
          <Fragment key={`action-${metric.key}`}>
            {showGroup ? (
              <h4 className={`review-rca-group${storeHealth ? " store-health-rca-group" : ""}`}>
                {groupLabel}
                {storeHealth ? (() => {
                  const count = orderedRows.filter((row) => group(row) === groupLabel).length;
                  return <small>{count} miss{count === 1 ? "" : "es"}</small>;
                })() : null}
              </h4>
            ) : null}
            <ReviewDetails className={`performance-action-item${storeHealth ? ` store-health-rca-item ${metric.severity}` : ""}`} id={cod ? "review-cod-remark" : undefined}>
              <summary>
                <span className={`metric-dot ${metric.severity}`} />
                <strong>{metric.label}</strong>
                <small>{evidence}</small>
                <b>
                  {storeHealth ? (
                    <em className={`store-health-rca-status ${item?.root_cause?.trim() && (!metric.reasonOnly ? item?.corrective_action?.trim() : true) ? "saved" : "needed"}`}>{status}</em>
                  ) : status}
                  <span className="review-rca-edit-label">{cta}{storeHealth ? "" : " ›"}</span>
                </b>
              </summary>
              <ReviewDetailsClose/>
              {metric.reasonOnly ? (
                <div className="review-delay-detail">
                  <p className="review-delay-evidence">{metric.evidence}</p>
                  {metric.key.startsWith("utr_late_") ? <ReviewPersonHistoryLink personId={metric.key.replace(/^utr_late_(employee|contractor)_/, "$1:")}/> : null}
                  {canSaveReason && activeDisciplineKeys.includes(metric.key) ? (
                    <ReviewActionForm action={cod ? savePerformanceCodRemark : savePerformanceDisciplineReason} className="review-delay-form">
                      <input type="hidden" name="review_id" value={reviewId} />
                      <input type="hidden" name="source_date" value={date} />
                      <input type="hidden" name="station_code" value={stationCode} />
                      <input type="hidden" name="metric_key" value={metric.key} />
                      <label>{cod ? "COD pendency reason / remarks" : "Reason for delay"}<input required name="root_cause" maxLength={DISCIPLINE_REASON_MAX} defaultValue={item?.root_cause ?? ""} placeholder={cod ? "Why is this COD still pending?" : "Brief reason, e.g. transport delay"} /></label>
                      <button className="button secondary">{cod ? "Save COD remark" : "Save reason"}</button>
                    </ReviewActionForm>
                  ) : (
                    <p className="review-delay-saved"><b>{cod ? "COD remarks" : "Reason"}</b> {item?.root_cause || (!reviewStarted ? "Start the review to add a short reason. No action plan is needed." : "Awaiting a short reason from the reviewer.")}</p>
                  )}
                </div>
              ) : canSaveMetric ? (
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
            </ReviewDetails>
          </Fragment>
        );
      })}
    </div>
  );
}
