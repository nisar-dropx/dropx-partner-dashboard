"use client";

import { useRef, useState, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import type { LiabilitySummaryNormalized } from "@/lib/ops-pulse/cash-recon-types";

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function CashSubmissionButton({
  disabled,
  stationCode,
  businessDate,
  varianceLabel,
  varianceType,
  workerConfigured
}: {
  disabled: boolean;
  stationCode: string;
  businessDate: string;
  varianceLabel: string;
  varianceType: "balanced" | "excess" | "short";
  workerConfigured: boolean;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [confirmingVariance, setConfirmingVariance] = useState(false);
  const [checking, setChecking] = useState(false);
  const [liability, setLiability] = useState<LiabilitySummaryNormalized | null>(null);
  const [overrideRemarks, setOverrideRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { pending } = useFormStatus();

  async function runLiabilityGate(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget.form;
    formRef.current = form;
    if (!form) return;

    if (varianceType !== "balanced" && !confirmingVariance) {
      setConfirmingVariance(true);
      return;
    }

    if (!workerConfigured) {
      form.requestSubmit();
      return;
    }

    setChecking(true);
    try {
      const response = await fetch("/api/ops-pulse/cod/cash-recon/liability-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationCode, date: businessDate })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to check SCC liability.");
      const summary = payload as LiabilitySummaryNormalized;
      // Cash summary only — MPOS / worker check.passed are ignored for the gate.
      if (summary.isClear) {
        form.requestSubmit();
        return;
      }
      setLiability(summary);
      setOverrideRemarks("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to check SCC liability.");
    } finally {
      setChecking(false);
    }
  }

  function submitWithOverride() {
    const form = formRef.current;
    if (!form || !overrideRemarks.trim()) return;
    let input = form.querySelector<HTMLInputElement>('input[name="liability_override_remarks"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "liability_override_remarks";
      form.appendChild(input);
    }
    input.value = overrideRemarks.trim();
    setLiability(null);
    form.requestSubmit();
  }

  if (liability) {
    const cash = liability.cashSummary;
    return (
      <div className="modal-backdrop" role="presentation">
        <section className="modal-panel wide cash-recon-modal" role="dialog" aria-modal="true" aria-labelledby="liability-title">
          <div className="panel-head">
            <div>
              <h2 id="liability-title">SCC liability still open</h2>
              <p className="subtle">{stationCode} · {businessDate} must be clear before cash submit.</p>
            </div>
            <button className="modal-close" type="button" onClick={() => setLiability(null)} aria-label="Close">×</button>
          </div>
          <div className="panel-body">
            <div className="reconciliation-final-summary" style={{ marginBottom: 14 }}>
              <div><span>Expected</span><strong>₹{currency(cash.expectedAmount)}</strong><small>Cash summary</small></div>
              <div><span>Actual</span><strong>₹{currency(cash.actualAmount)}</strong><small>Count {cash.count}</small></div>
              <div><span>Short / excess</span><strong>₹{currency(cash.shortExcessAmount)}</strong><small>Must be ₹0</small></div>
            </div>
            <p className="subtle" style={{ marginBottom: 12 }}>
              Clear station cash liability in SCC, or provide a manual override remark to continue. MPOS is not required for this check.
            </p>
            <label style={{ display: "grid", gap: 6 }}>
              Manual override remarks
              <textarea
                className="field"
                rows={3}
                value={overrideRemarks}
                onChange={(event) => setOverrideRemarks(event.target.value)}
                placeholder="Why are you submitting while SCC liability is still open?"
              />
            </label>
            <div className="form-actions modal-actions" style={{ marginTop: 14 }}>
              <button className="button ghost" type="button" onClick={() => setLiability(null)}>Go back</button>
              <button className="button" type="button" disabled={!overrideRemarks.trim() || pending} onClick={submitWithOverride}>
                {pending ? "Submitting…" : "Override & submit"}
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (varianceType !== "balanced" && confirmingVariance) {
    return (
      <div className={`cash-submit-confirm ${varianceType}`} role="alert">
        <div>
          <strong>{varianceLabel}</strong>
          <span>
            Submission is allowed. The variance will remain open, the manager will be notified, and SCC liability will be checked next.
          </span>
        </div>
        <div className="form-actions">
          <button className="button ghost" disabled={pending || checking} onClick={() => setConfirmingVariance(false)} type="button">
            Go back
          </button>
          <button className="button" disabled={disabled || pending || checking} onClick={runLiabilityGate} type="button">
            {checking ? "Checking SCC…" : pending ? "Submitting…" : "Confirm & check SCC"}
          </button>
        </div>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <button
        className={varianceType === "short" ? "button danger-button" : "button"}
        disabled={disabled || pending || checking}
        onClick={runLiabilityGate}
        type="button"
      >
        {checking
          ? "Checking SCC…"
          : pending
            ? "Submitting…"
            : varianceType === "balanced"
              ? "Submit cash & run SCC"
              : `Submit with ${varianceType}`}
      </button>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
