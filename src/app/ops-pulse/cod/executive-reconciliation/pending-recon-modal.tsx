"use client";

import type { CashReconPendingBreakdown } from "@/lib/ops-pulse/cash-recon-types";

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatCollectionTime(epochMs: number | null) {
  if (!epochMs || !Number.isFinite(epochMs)) return "-";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata"
    }).format(new Date(epochMs));
  } catch {
    return "-";
  }
}

export function PendingReconModal({
  associateName,
  pendingAmount,
  breakdown,
  overrideRemarks,
  onOverrideRemarksChange,
  onClose,
  onConfirmOverride
}: {
  associateName: string;
  pendingAmount: number;
  breakdown: CashReconPendingBreakdown[];
  overrideRemarks: string;
  onOverrideRemarksChange: (value: string) => void;
  onClose: () => void;
  onConfirmOverride: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-panel wide cash-recon-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-recon-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="panel-head">
          <div>
            <h2 id="pending-recon-title">Cash recon pending</h2>
            <p className="subtle">{associateName} still has ₹{currency(pendingAmount)} pending in SCC.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="panel-body">
          <p className="subtle" style={{ marginBottom: 12 }}>
            Ask the associate to complete pending recon or hand over the full cash so pending becomes zero, then return here to count denominations.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tracking ID</th>
                  <th>Method</th>
                  <th>Amount</th>
                  <th>Collected</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.length ? breakdown.map((row) => (
                  <tr key={`${row.trackingId}-${row.moneyCollectionTime ?? 0}`}>
                    <td>{row.trackingId}</td>
                    <td>{row.paymentMethod}</td>
                    <td>₹{currency(row.amount)}</td>
                    <td>{formatCollectionTime(row.moneyCollectionTime)}</td>
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={4}>No tracking-level breakdown returned.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <label style={{ display: "grid", gap: 6, marginTop: 14 }}>
            Manual override remarks
            <textarea
              className="field"
              rows={3}
              value={overrideRemarks}
              onChange={(event) => onOverrideRemarksChange(event.target.value)}
              placeholder="Why are you counting cash while pending recon is still open?"
            />
          </label>
          <div className="form-actions modal-actions" style={{ marginTop: 14 }}>
            <button className="button ghost" type="button" onClick={onClose}>Wait for zero pending</button>
            <button
              className="button"
              type="button"
              disabled={!overrideRemarks.trim()}
              onClick={onConfirmOverride}
            >
              Override & continue
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
