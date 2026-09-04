"use client";

import { useEffect, useId, useRef, useState } from "react";
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

type FocusField = "root_cause" | "corrective_action" | "action_owner";

type Props = {
  canEdit: boolean;
  date: string;
  itemsByMetric: Map<string, PerformanceReviewItem>;
  misses: ReviewMetric[];
  reviewId: string;
  reviewVersion: string;
  stationCode: string;
};

function valueText(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function statusLabel(status: string | undefined) {
  return (status || "needs_rca").replaceAll("_", " ");
}

function preview(value: string | null | undefined, empty: string) {
  const text = String(value ?? "").trim();
  if (!text) return empty;
  return text.length > 110 ? `${text.slice(0, 107)}…` : text;
}

export function PerformanceRcaActions({
  canEdit,
  date,
  itemsByMetric,
  misses,
  reviewId,
  reviewVersion,
  stationCode
}: Props) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusField, setFocusField] = useState<FocusField>("root_cause");
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeMetric = misses.find((metric) => metric.key === activeKey) ?? null;
  const activeItem = activeMetric ? itemsByMetric.get(activeMetric.key) : null;

  function openEditor(metricKey: string, field: FocusField) {
    if (!canEdit) return;
    setFocusField(field);
    setActiveKey(metricKey);
  }

  function closeEditor() {
    setActiveKey(null);
  }

  useEffect(() => {
    if (!activeKey) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeKey]);

  useEffect(() => {
    if (!activeKey || !activeMetric) return;
    const field = document.getElementById(`rca-field-${focusField}`) as HTMLTextAreaElement | HTMLInputElement | null;
    field?.focus();
    if (field && "setSelectionRange" in field && typeof field.value === "string") {
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
  }, [activeKey, activeMetric, focusField]);

  if (!misses.length) return null;

  return (
    <div className="performance-review-actions">
      <div className="performance-rca-head">
        <div>
          <h3>RCA and next-day actions</h3>
          <p>{misses.length} metric{misses.length === 1 ? "" : "s"} off target. Capture the root cause and the action before the next review.</p>
        </div>
        <b>{misses.filter((metric) => itemsByMetric.get(metric.key)?.status === "done").length}/{misses.length} done</b>
      </div>

      <div className="performance-rca-list">
        {misses.map((metric) => {
          const item = itemsByMetric.get(metric.key);
          const hasRca = Boolean(item?.root_cause?.trim());
          const hasAction = Boolean(item?.corrective_action?.trim());
          return (
            <article className={`performance-rca-card ${metric.severity}`} key={metric.key}>
              <header>
                <span className={`metric-dot ${metric.severity}`} aria-hidden="true" />
                <div>
                  <strong>{metric.label}</strong>
                  <small>
                    Actual {valueText(metric.actual)}
                    {metric.target == null ? "" : ` · Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}
                  </small>
                </div>
                <em className={item?.status || "needs-rca"}>{statusLabel(item?.status)}</em>
              </header>

              <div className="performance-rca-preview">
                <button
                  type="button"
                  className={!hasRca ? "empty" : undefined}
                  onClick={() => openEditor(metric.key, "root_cause")}
                  disabled={!canEdit && !hasRca}
                >
                  <span>Root cause</span>
                  <strong>{preview(item?.root_cause, canEdit ? "Tap to add what went wrong" : "Awaiting update")}</strong>
                </button>
                <button
                  type="button"
                  className={!hasAction ? "empty" : undefined}
                  onClick={() => openEditor(metric.key, "corrective_action")}
                  disabled={!canEdit && !hasAction}
                >
                  <span>Next action</span>
                  <strong>{preview(item?.corrective_action, canEdit ? "Tap to add the next-day fix" : "Awaiting update")}</strong>
                </button>
              </div>

              <footer>
                <small>
                  {item?.action_owner || (canEdit ? "Owner not set" : "—")}
                  {item?.due_date ? ` · due ${formatDashboardDate(item.due_date)}` : ""}
                </small>
                {canEdit ? (
                  <button type="button" className="button secondary" onClick={() => openEditor(metric.key, hasRca ? "corrective_action" : "root_cause")}>
                    {hasRca || hasAction ? "Edit" : "Add RCA"}
                  </button>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>

      {canEdit && activeMetric ? (
        <div className="modal-backdrop performance-rca-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section className="modal-panel performance-rca-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <header>
              <div>
                <span className={`metric-dot ${activeMetric.severity}`} aria-hidden="true" />
                <div>
                  <strong id={titleId}>{activeMetric.label}</strong>
                  <small>
                    Actual {valueText(activeMetric.actual)}
                    {activeMetric.target == null ? "" : ` · Target ${activeMetric.direction === "higher" ? "≥" : "≤"} ${valueText(activeMetric.target)}`}
                  </small>
                </div>
              </div>
              <button ref={closeRef} className="modal-close" type="button" onClick={closeEditor} aria-label="Close">×</button>
            </header>

            <p className="performance-rca-help">Write a clear root cause and one concrete next-day action. Keep ownership and due date visible so follow-up is easy.</p>

            <ReviewActionForm
              action={savePerformanceReviewItem}
              className="performance-rca-form"
              onSaved={closeEditor}
            >
              <input type="hidden" name="review_id" value={reviewId} />
              <input type="hidden" name="source_date" value={date} />
              <input type="hidden" name="station_code" value={stationCode} />
              <input type="hidden" name="review_version" value={reviewVersion} />
              <input type="hidden" name="metric_key" value={activeMetric.key} />
              <input type="hidden" name="metric_label" value={activeMetric.label} />
              <input type="hidden" name="actual_value" value={activeMetric.actual ?? ""} />
              <input type="hidden" name="target_value" value={activeMetric.target ?? ""} />
              <input type="hidden" name="target_direction" value={activeMetric.direction} />
              <input type="hidden" name="severity" value={activeMetric.severity} />

              <label>
                Root cause
                <textarea
                  id="rca-field-root_cause"
                  required
                  name="root_cause"
                  rows={4}
                  defaultValue={activeItem?.root_cause ?? ""}
                  placeholder="What specifically caused this miss? Avoid vague notes like 'ops issue'."
                />
              </label>

              <label>
                Next-day action
                <textarea
                  id="rca-field-corrective_action"
                  required
                  name="corrective_action"
                  rows={4}
                  defaultValue={activeItem?.corrective_action ?? ""}
                  placeholder="What will be done before the next review, and how will we know it worked?"
                />
              </label>

              <div className="performance-rca-meta">
                <label>
                  Owner
                  <input
                    id="rca-field-action_owner"
                    required
                    name="action_owner"
                    defaultValue={activeItem?.action_owner ?? ""}
                    placeholder="Who owns this action?"
                  />
                </label>
                <label>
                  Due date
                  <input type="date" name="due_date" defaultValue={activeItem?.due_date ?? date} />
                </label>
                <label>
                  Status
                  <select name="status" defaultValue={activeItem?.status ?? "open"}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="blocked">Blocked</option>
                    <option value="done">Done</option>
                  </select>
                </label>
              </div>

              <div className="form-actions modal-actions">
                <button className="button secondary" type="button" onClick={closeEditor}>Cancel</button>
                <button className="button" type="submit">Save RCA & action</button>
              </div>
            </ReviewActionForm>
          </section>
        </div>
      ) : null}
    </div>
  );
}
