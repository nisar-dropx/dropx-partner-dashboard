"use client";

import { useState } from "react";
import { bypassPerformanceReviewLevel, closeReopenedPerformanceReviewAccess, proxyPerformanceReview, reopenPerformanceReviewForOriginalReviewer, undoBypassPerformanceReviewLevel } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

/** Only the fields this component actually reads — lets both the Review Desk's full
 * PerformanceReview/PerformanceReviewStep and Control Tower's lighter ReviewStatusReview/
 * ReviewStatusStep pass through without reshaping. */
type ExceptionsReview = {
  id: string;
  source_date: string;
  station_code: string;
  updated_at: string;
  status: string;
  current_step_order: number;
};
type ExceptionsStep = {
  id: string;
  step_order: number;
  status: string;
  reviewer_name: string;
  reviewer_role: string;
  proxy_reviewer_user_id?: string | null;
  bypassed_at?: string | null;
  bypass_reason?: string | null;
};

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
  reviewerEditReopened,
  firstReviewerName,
  darkStore = false,
}: {
  review: ExceptionsReview | null;
  steps: ExceptionsStep[];
  canBypass: boolean;
  canProxy: boolean;
  canAccessBypass: boolean;
  canAccessProxy: boolean;
  canUndoBypass: boolean;
  canStart: boolean;
  hasRoute: boolean;
  routeLabel?: string;
  /** Dark Store reviews are City → Regional → National Head (not LM CM/AOM). */
  darkStore?: boolean;
  /** Oversight has re-opened edit access for the original CM/AOM reviewer. */
  reviewerEditReopened?: boolean;
  /** Display name of the original (first-stage) reviewer, for the reopen button's label. */
  firstReviewerName?: string | null;
}) {
  const [mode, setMode] = useState<"proxy" | "skip" | "undo" | null>(null);
  const [editAccessConfirm, setEditAccessConfirm] = useState<"reopen" | "revoke" | null>(null);
  const current =
    steps.find((step) => step.step_order === review?.current_step_order && step.status === "pending") ??
    (!review ? steps.find((step) => step.status === "pending") : undefined);
  const pending = steps.filter((step) => step.status === "pending");
  const skipped = steps.filter((step) => step.status === "skipped" && step.bypassed_at);
  // Buttons stay visible even without oversight rights — a viewer who can open this review
  // should be able to discover Proxy/Skip exist and see why they're disabled for them,
  // rather than the section silently disappearing.
  const noAccessReason = "You don't have rights for this action — contact your Program Manager, Regional Manager, or an authorised oversight reviewer.";

  const inactiveReason = !hasRoute
    ? darkStore
      ? "Map City Manager → Regional Manager → National Head in People for this store. After Start review, authorised oversight can still use Conduct proxy review and Skip a level."
      : "A review manager needs to be assigned in People. Contact HR so this station gets a Cluster Manager → National Head route."
    : !review
      ? canStart
        ? darkStore
          ? "Start review first for this store and date, then Conduct proxy or Skip a level."
          : "Start review first for this station and date, then use Proxy or Skip."
        : darkStore
          ? "The review has not started for this store and date. Ask the City Manager to start it, or use Start review if you have oversight."
          : "The review has not started for this station and date. Ask the assigned review manager to start it."
      : review.status === "closed" && !skipped.length
        ? "Review completed. There are no pending levels to skip or cover."
        : !pending.length && !skipped.length
          ? "There are no pending levels to skip or cover."
          : pending.length && !current
            ? "The current review level is unavailable. Refresh the review before continuing."
            : null;

  const proxyEnabled = Boolean(review && pending.length && current && canProxy);
  // Skip: oversight OR a higher reviewer on this route (e.g. Regional Manager skipping City).
  const skipEnabled = Boolean(review && pending.length && canBypass);
  // Undo skip + reopen edit stay oversight-only (canAccessBypass), never higher-reviewer Skip alone.
  const undoEnabled = Boolean(review && skipped.length && canAccessBypass && canUndoBypass);

  const proxyHint =
    !canAccessProxy
      ? noAccessReason
      : inactiveReason ||
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
  const skipHint = !canBypass ? noAccessReason : inactiveReason;

  return (
    <section className="review-exceptions" aria-label="Review cover and exceptions">
      <div className="review-exception-buttons">
        <button
          type="button"
          className="button secondary"
          disabled={!canAccessProxy || !proxyEnabled}
          aria-describedby="review-exception-guidance"
          title={!canAccessProxy ? noAccessReason : undefined}
          onClick={() => setMode(mode === "proxy" ? null : "proxy")}
        >
          Conduct proxy review
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!skipEnabled}
          aria-describedby="review-exception-guidance"
          title={!canBypass ? noAccessReason : undefined}
          onClick={() => setMode(mode === "skip" ? null : "skip")}
        >
          Skip a level…
        </button>
        {skipped.length ? (
          <button
            type="button"
            className="button secondary"
            disabled={!canAccessBypass || !undoEnabled}
            title={!canAccessBypass ? noAccessReason : undefined}
            onClick={() => setMode(mode === "undo" ? null : "undo")}
          >
            Undo skip…
          </button>
        ) : null}
        {review ? (
          <button
            type="button"
            className="button secondary"
            disabled={!canAccessBypass}
            title={!canAccessBypass ? noAccessReason : undefined}
            onClick={() => {
              if (!canAccessBypass) return;
              setMode(null);
              setEditAccessConfirm(reviewerEditReopened ? "revoke" : "reopen");
            }}
          >
            {reviewerEditReopened
              ? "Revoke reopened edit access"
              : `Give edit access back to ${firstReviewerName || "CM/AOM"}`}
          </button>
        ) : null}
      </div>
      {review && editAccessConfirm && canAccessBypass ? (
        <div
          className="modal-backdrop confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditAccessConfirm(null);
          }}
        >
          <section
            aria-labelledby="review-edit-access-confirm-title"
            aria-modal="true"
            className="modal-panel confirmation-dialog"
            role="alertdialog"
          >
            <div className="panel-head">
              <div>
                <h2 id="review-edit-access-confirm-title">
                  {editAccessConfirm === "revoke" ? "Revoke reopened edit access?" : "Give edit access back?"}
                </h2>
                <p className="subtle">
                  {editAccessConfirm === "revoke"
                    ? "The original reviewer will lose the temporary edit rights that were reopened for this review."
                    : `${firstReviewerName || "The original CM/AOM"} will be able to edit RCA, connections and actions again on this review.`}
                </p>
              </div>
            </div>
            <div className="confirmation-body">
              <p>
                {editAccessConfirm === "revoke"
                  ? "Confirm only if that temporary edit window should end now."
                  : "Use this only when oversight wants the station reviewer to continue editing after a higher level has already worked on the review."}
              </p>
            </div>
            <ReviewActionForm
              key={editAccessConfirm}
              action={editAccessConfirm === "revoke" ? closeReopenedPerformanceReviewAccess : reopenPerformanceReviewForOriginalReviewer}
              className="review-reopen-confirm-form"
              onSaved={() => setEditAccessConfirm(null)}
            >
              <input type="hidden" name="review_id" value={review.id} />
              <input type="hidden" name="source_date" value={review.source_date} />
              <input type="hidden" name="station_code" value={review.station_code} />
              <input type="hidden" name="review_version" value={review.updated_at} />
              <div className="form-actions modal-actions confirmation-actions">
                <button type="button" className="button secondary" onClick={() => setEditAccessConfirm(null)}>
                  Cancel
                </button>
                <button type="submit" className="button">
                  {editAccessConfirm === "revoke" ? "Revoke edit access" : `Give edit access to ${firstReviewerName || "CM/AOM"}`}
                </button>
              </div>
            </ReviewActionForm>
          </section>
        </div>
      ) : null}
      {inactiveReason || skipHint || (!proxyEnabled && canAccessProxy) || (review?.status === "closed" && skipped.length) || !canAccessProxy || (!canAccessBypass && !canBypass) ? (
        <p id="review-exception-guidance" className="review-exception-guidance">
          {proxyHint || skipHint || inactiveReason}
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
