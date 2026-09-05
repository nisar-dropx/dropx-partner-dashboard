"use client";

import { useState } from "react";
import type { PerformanceReview, PerformanceReviewStep } from "@/lib/ops-pulse/performance-review";
import { bypassPerformanceReviewLevel, proxyPerformanceReview, undoBypassPerformanceReviewLevel } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

export function PerformanceReviewExceptions({
  review,
  steps,
  canBypass,
  canProxy,
  canAccessBypass,
  canAccessProxy,
  canUndoBypass,
  canStart,
  hasRoute,
  routeLabel,
}: {
  review: PerformanceReview | null;
  steps: PerformanceReviewStep[];
  canBypass: boolean;
  canProxy: boolean;
  canAccessBypass: boolean;
  canAccessProxy: boolean;
  canUndoBypass: boolean;
  canStart: boolean;
  hasRoute: boolean;
  routeLabel?: string;
}) {
  const [mode, setMode] = useState<"proxy" | "skip" | "undo" | null>(null);
  const current =
    steps.find((step) => step.step_order === review?.current_step_order && step.status === "pending") ??
    (!review ? steps.find((step) => step.status === "pending") : undefined);
  const pending = steps.filter((step) => step.status === "pending");
  const skipped = steps.filter((step) => step.status === "skipped" && step.bypassed_at);
  if (!canAccessBypass && !canAccessProxy && !canUndoBypass) return null;

  const inactiveReason = !hasRoute
    ? "A review manager needs to be assigned in People. Contact HR so this station gets a Cluster Manager → National Head route."
    : !review
      ? canStart
        ? "Start review first for this station and date, then use Proxy or Skip."
        : "The review has not started for this station and date. Ask the assigned review manager to start it."
      : review.status === "closed" && !skipped.length
        ? "Review completed. There are no pending levels to skip or cover."
        : !pending.length && !skipped.length
          ? "There are no pending levels to skip or cover."
          : pending.length && !current
            ? "The current review level is unavailable. Refresh the review before continuing."
            : null;

  const proxyEnabled = Boolean(review && pending.length && current && canProxy);
  const skipEnabled = Boolean(review && pending.length && canBypass);
  const undoEnabled = Boolean(review && skipped.length && canUndoBypass);

  const proxyHint =
    inactiveReason ||
    (canProxy
      ? null
      : review?.status === "closed" && skipped.length
        ? "Proxy is unavailable while the review is closed after a skip. Use Undo skip below to reopen it."
        : current?.proxy_reviewer_user_id
          ? "You are already covering this level as proxy (or another proxy is assigned). Complete it in Review discussion, or Undo skip if a later level was closed by mistake."
          : !canProxy && canBypass && pending.length && current
            ? "This is your assigned review level — complete it here, or use Skip if that manager should be bypassed."
            : hasRoute
              ? "Proxy is for a higher manager or authorised oversight covering this station."
              : "Proxy needs a People review route for this station.");

  return (
    <section className="review-exceptions" aria-label="Review cover and exceptions">
      <div className="review-exception-buttons">
        {canAccessProxy ? (
          <button
            type="button"
            className="button secondary"
            disabled={!proxyEnabled}
            aria-describedby={!proxyEnabled ? "review-exception-guidance" : undefined}
            onClick={() => setMode(mode === "proxy" ? null : "proxy")}
          >
            Conduct proxy review
          </button>
        ) : null}
        {canAccessBypass ? (
          <button
            type="button"
            className="button secondary"
            disabled={!skipEnabled}
            aria-describedby={inactiveReason ? "review-exception-guidance" : undefined}
            onClick={() => setMode(mode === "skip" ? null : "skip")}
          >
            Skip a level…
          </button>
        ) : null}
        {canUndoBypass && skipped.length ? (
          <button type="button" className="button secondary" disabled={!undoEnabled} onClick={() => setMode(mode === "undo" ? null : "undo")}>
            Undo skip…
          </button>
        ) : null}
      </div>
      {inactiveReason || (!proxyEnabled && canAccessProxy) || (review?.status === "closed" && skipped.length) ? (
        <p id="review-exception-guidance" className="review-exception-guidance">
          {inactiveReason || proxyHint}
          {!review && canStart && hasRoute ? (
            <>
              {" "}
              <a href="#start-station-review">Go to Start review ↑</a>
            </>
          ) : null}
          {hasRoute && routeLabel ? <small className="review-exception-route"> Route: {routeLabel}</small> : null}
        </p>
      ) : null}
      {review && mode === "proxy" && proxyEnabled ? (
        <ReviewActionForm key="proxy" action={proxyPerformanceReview} className="review-exception-form" onSaved={() => setMode(null)}>
          <input type="hidden" name="review_id" value={review.id} />
          <input type="hidden" name="source_date" value={review.source_date} />
          <input type="hidden" name="station_code" value={review.station_code} />
          <input type="hidden" name="review_version" value={review.updated_at} />
          <input type="hidden" name="step_id" value={current?.id ?? ""} />
          <p>
            You will conduct the review on behalf of <strong>{current?.reviewer_name}</strong>. Add the review inputs, then complete their level.
          </p>
          <label>
            Why is the assigned manager unable to review?
            <textarea name="reason" required minLength={5} maxLength={2000} rows={2} />
          </label>
          <div className="review-exception-buttons">
            <button className="button">Take proxy review</button>
            <button type="button" className="button secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </ReviewActionForm>
      ) : null}
      {review && mode === "skip" && skipEnabled ? (
        <ReviewActionForm key="skip" action={bypassPerformanceReviewLevel} className="review-exception-form" onSaved={() => setMode(null)}>
          <input type="hidden" name="review_id" value={review.id} />
          <input type="hidden" name="source_date" value={review.source_date} />
          <input type="hidden" name="station_code" value={review.station_code} />
          <input type="hidden" name="review_version" value={review.updated_at} />
          <p>
            This level will be marked <strong>Skipped</strong>, not reviewed. You can undo it later if this was accidental.
          </p>
          <label>
            Pending level
            <select name="step_id" required>
              {pending.map((step) => (
                <option value={step.id} key={step.id}>
                  {step.reviewer_role} · {step.reviewer_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Why is this level being skipped?
            <textarea name="reason" required minLength={5} maxLength={2000} rows={2} />
          </label>
          <div className="review-exception-buttons">
            <button className="button">Confirm skip</button>
            <button type="button" className="button secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </ReviewActionForm>
      ) : null}
      {review && mode === "undo" && undoEnabled ? (
        <ReviewActionForm key="undo" action={undoBypassPerformanceReviewLevel} className="review-exception-form" onSaved={() => setMode(null)}>
          <input type="hidden" name="review_id" value={review.id} />
          <input type="hidden" name="source_date" value={review.source_date} />
          <input type="hidden" name="station_code" value={review.station_code} />
          <input type="hidden" name="review_version" value={review.updated_at} />
          <p>
            Restore a skipped level to <strong>pending</strong>. If the review was closed by that skip, it reopens.
          </p>
          <label>
            Skipped level
            <select name="step_id" required>
              {skipped.map((step) => (
                <option value={step.id} key={step.id}>
                  {step.reviewer_role} · {step.reviewer_name}
                  {step.bypass_reason ? ` · ${step.bypass_reason}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="review-exception-buttons">
            <button className="button">Undo skip</button>
            <button type="button" className="button secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </ReviewActionForm>
      ) : null}
    </section>
  );
}
