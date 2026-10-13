"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { WorkforcePayoutSourceIdentity } from "@/lib/workforce-payout-source-hold";

export type WorkforcePayoutHoldSelection = {
  workforceId?: string;
  sourceTargets: WorkforcePayoutSourceIdentity[];
  dropxId: string;
  name: string;
};

type HoldAction = "hold" | "release_hold";
type HoldControlMode = "bulk" | "single";

const ignoreBusyChange = (_busy: boolean) => undefined;
const ignoreCompleted = (_action: HoldAction, _changed: number, _processed: number) => undefined;

export function WorkforcePayoutBulkHold({
  audience = "workforce",
  disabled,
  holdItems,
  mode = "bulk",
  onBusyChange = ignoreBusyChange,
  onCompleted = ignoreCompleted,
  periodEnd,
  periodStart,
  releaseItems
}: {
  audience?: "workforce" | "helpers";
  disabled: boolean;
  holdItems: WorkforcePayoutHoldSelection[];
  mode?: HoldControlMode;
  onBusyChange?: (busy: boolean) => void;
  onCompleted?: (action: HoldAction, changed: number, processed: number) => void;
  periodStart: string;
  periodEnd: string;
  releaseItems: WorkforcePayoutHoldSelection[];
}) {
  const router = useRouter();
  const titleId = useId();
  const [action, setAction] = useState<HoldAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const items = useMemo(
    () => action === "release_hold" ? releaseItems : holdItems,
    [action, holdItems, releaseItems]
  );

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    if (!action) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setAction(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeys);
    return () => {
      document.removeEventListener("keydown", handleKeys);
      trigger?.focus();
    };
  }, [action, busy]);

  function showDialog(nextAction: HoldAction, trigger: HTMLButtonElement) {
    const nextItems = nextAction === "hold" ? holdItems : releaseItems;
    if (disabled || !nextItems.length) return;
    triggerRef.current = trigger;
    setRemarks("");
    setError("");
    setOperationId(crypto.randomUUID());
    setAction(nextAction);
  }

  function closeDialog() {
    if (busy) return;
    setAction(null);
    setError("");
  }

  async function submit() {
    const reason = remarks.trim();
    if (!action || busy || !items.length || reason.length < 3 || reason.length > 1000 || !operationId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          audience,
          operationId,
          workforceIds: [...new Set(items.flatMap((item) => item.workforceId ? [item.workforceId] : []))],
          sourceTargets: [...new Map(items.flatMap((item) =>
            audience === "workforce" && (action === "release_hold" || !item.workforceId) ? item.sourceTargets : []
          ).map((target) => [
            `${target.stationId}|${target.providerIdentity}|${target.providerMemberId}`,
            target
          ])).values()],
          periodStart,
          periodEnd,
          remarks: reason
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to update the selected payment holds.");
      const processed = items.length;
      const changed = Math.min(processed, Number(payload?.changed ?? processed));
      const completedAction = action;
      setAction(null);
      setRemarks("");
      onCompleted(completedAction, changed, processed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the selected payment holds.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const releasing = action === "release_hold";
  const single = mode === "single";
  const subjectLabel = audience === "helpers" ? "Helper" : "Workforce";
  const modal = action && typeof document !== "undefined" ? createPortal(
    <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }} role="presentation">
      <section aria-labelledby={titleId} aria-modal="true" className="modal-panel confirmation-dialog" ref={modalRef} role="alertdialog">
        <div className="panel-head">
          <div>
            <p className="eyebrow">{subjectLabel} payments</p>
            <h2 id={titleId}>{single
              ? releasing ? "Release payment hold" : "Place payment on hold"
              : releasing ? "Unhold selected payments" : "Hold selected payments"}</h2>
          </div>
          <button aria-label="Close payment hold dialog" className="button secondary compact" disabled={busy} onClick={closeDialog} ref={closeRef} type="button">Close</button>
        </div>
        <div className="panel-body">
          <p>{single
            ? `${releasing ? "Release the hold on" : "Place on hold"} ${items[0]?.dropxId || items[0]?.name || `this ${subjectLabel.toLowerCase()} payment`}?`
            : <>{releasing ? "Release the hold on" : "Place on hold"} {items.length.toLocaleString("en-IN")} selected {subjectLabel} payment{items.length === 1 ? "" : "s"}?</>}</p>
          <div className={`payout-inline-message ${releasing ? "" : "warn"}`}>
            <strong>{releasing ? "Future balance can be paid" : "Bank payment remains blocked"}</strong>
            <p>{releasing
              ? "After the hold is released, a positive eligible balance can be included in a later bank file."
              : "The hold stays active for this payout month even if payout data is corrected later or its balance changes from zero to a positive amount."}</p>
          </div>
          <div className="payout-inline-message">
            <strong>{single ? "DropX ID" : "Selected DropX IDs"}</strong>
            <p>{items.slice(0, 8).map((item) => item.dropxId || item.name).join(", ")}{items.length > 8 ? ` and ${items.length - 8} more` : ""}</p>
          </div>
          <label>
            <span>{releasing ? "Unhold remarks" : "Hold remarks"}</span>
            <textarea
              autoFocus
              className="field"
              disabled={busy}
              maxLength={1000}
              minLength={3}
              onChange={(event) => setRemarks(event.target.value)}
              placeholder={releasing ? "Enter why these payments are being released." : "Enter why these payments are being placed on hold."}
              required
              rows={4}
              value={remarks}
            />
          </label>
          <p className="subtle">3–1,000 characters. {single ? "The audited remark is saved in payment history." : "The same audited remark is recorded for every selected DropX ID."}</p>
          {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
          <div className="form-actions">
            <button className="button secondary" disabled={busy} onClick={closeDialog} type="button">Cancel</button>
            <button className="button" disabled={busy || remarks.trim().length < 3} onClick={submit} type="button">{busy
              ? "Saving…"
              : single
                ? releasing ? "Release hold" : "Place on hold"
                : releasing ? `Unhold ${items.length.toLocaleString("en-IN")}` : `Hold ${items.length.toLocaleString("en-IN")}`}</button>
          </div>
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    {single
      ? releaseItems.length
        ? <button className="button secondary compact" disabled={busy || disabled} onClick={(event) => showDialog("release_hold", event.currentTarget)} type="button">Unhold</button>
        : holdItems.length
          ? <button className="button secondary compact" disabled={busy || disabled} onClick={(event) => showDialog("hold", event.currentTarget)} type="button">Hold</button>
          : null
      : <>
        <button className="button secondary" disabled={busy || disabled || !holdItems.length} onClick={(event) => showDialog("hold", event.currentTarget)} type="button">Hold{holdItems.length ? ` (${holdItems.length.toLocaleString("en-IN")})` : ""}</button>
        <button className="button secondary" disabled={busy || disabled || !releaseItems.length} onClick={(event) => showDialog("release_hold", event.currentTarget)} type="button">Unhold{releaseItems.length ? ` (${releaseItems.length.toLocaleString("en-IN")})` : ""}</button>
      </>}
    {modal}
  </>;
}
