"use client";
import { useState, useTransition } from "react";
import { placeSalaryHold, requestSalaryHoldCancellation } from "@/app/ops-pulse/attendance/salary-hold/actions";
import type { SalaryHoldRecord, SalaryHoldWorkspace } from "@/lib/ops-pulse/salary-hold-data";

const statusPillClass = (status: string) => {
  if (status === "applied") return "status-pill good";
  if (status === "cancelled") return "status-pill bad";
  if (status === "cancel_requested") return "status-pill warn";
  return "status-pill";
};

const dateTimeLabel = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";

function HoldRow({ hold, onActed }: { hold: SalaryHoldRecord; onActed: () => void }) {
  const [note, setNote] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);

  function submitCancelRequest() {
    setError("");
    const formData = new FormData();
    formData.set("holdId", hold.id);
    formData.set("note", note.trim());
    startTransition(async () => {
      const result = await requestSalaryHoldCancellation(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onActed();
    });
  }

  return (
    <div className="osh-hold-row">
      <div className="osh-hold-head">
        <div>
          <strong>{hold.workerDisplayName}</strong>
          <span className={statusPillClass(hold.status)}>{hold.status.replace(/_/g, " ")}</span>
        </div>
        <small>{dateTimeLabel(hold.requestedAt)}</small>
      </div>
      <p className="osh-hold-detail">
        {hold.holdType === "amount" ? `Amount hold: ₹${hold.amount ?? 0}` : `Days hold: ${hold.days ?? 0} day(s)`}
      </p>
      <p className="osh-hold-detail">Reason: {hold.reason}</p>
      {hold.status === "cancel_requested" && (
        <p className="osh-hold-detail">Cancellation requested{hold.cancelRequestNote ? ` — ${hold.cancelRequestNote}` : ""}, awaiting HR decision.</p>
      )}
      {hold.status === "applied" && (
        <p className="osh-hold-detail">Applied{hold.appliedAmount != null ? ` — ₹${hold.appliedAmount}` : ""} on {dateTimeLabel(hold.appliedAt)}.</p>
      )}
      {hold.status === "cancelled" && hold.cancellationNote && (
        <p className="osh-hold-detail">HR note: {hold.cancellationNote}</p>
      )}
      {hold.status === "pending" && !requesting && (
        <button type="button" className="button secondary" onClick={() => setRequesting(true)}>
          Request cancellation
        </button>
      )}
      {hold.status === "pending" && requesting && (
        <div className="osh-cancel-form">
          <textarea
            className="field"
            placeholder="Optional note for HR about why this hold should be cancelled"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
          />
          <div className="osh-hold-buttons">
            <button type="button" className="button secondary" disabled={busy} onClick={submitCancelRequest}>
              {busy ? "Submitting…" : "Submit cancellation request"}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setRequesting(false)}>
              Back
            </button>
          </div>
          {error && <p className="ooc-gate-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function PlaceHoldForm({ workspace, onPlaced }: { workspace: SalaryHoldWorkspace; onPlaced: () => void }) {
  const [workerKey, setWorkerKey] = useState("");
  const [holdType, setHoldType] = useState<"amount" | "days">("amount");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function submit() {
    setError("");
    setSuccess("");
    const worker = workspace.eligibleWorkers.find((w) => `${w.workerType}:${w.workerId}` === workerKey);
    if (!worker) {
      setError("Select a worker to place a hold on.");
      return;
    }
    const formData = new FormData();
    formData.set("workerType", worker.workerType);
    formData.set("workerId", worker.workerId);
    formData.set("holdType", holdType);
    formData.set("amount", amount);
    formData.set("days", days);
    formData.set("reason", reason);
    startTransition(async () => {
      const result = await placeSalaryHold(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSuccess(result.message);
      setWorkerKey("");
      setAmount("");
      setDays("");
      setReason("");
      onPlaced();
    });
  }

  return (
    <section className="panel osh-form">
      <h2>Place a salary hold</h2>
      {workspace.eligibleWorkers.length === 0 && (
        <p className="osh-hold-detail">You have no direct reports currently on record to place a hold on.</p>
      )}
      {workspace.eligibleWorkers.length > 0 && (
        <div className="osh-fields">
          <label className="osh-label">
            Worker
            <select className="field" value={workerKey} onChange={(e) => setWorkerKey(e.target.value)} disabled={busy}>
              <option value="">Select a direct report…</option>
              {workspace.eligibleWorkers.map((w) => (
                <option key={`${w.workerType}:${w.workerId}`} value={`${w.workerType}:${w.workerId}`}>
                  {w.displayName} {w.designationName ? `(${w.designationName})` : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="osh-toggle">
            <button
              type="button"
              className={holdType === "amount" ? "osh-toggle-btn osh-toggle-btn-active" : "osh-toggle-btn"}
              onClick={() => setHoldType("amount")}
              disabled={busy}
            >
              Amount
            </button>
            <button
              type="button"
              className={holdType === "days" ? "osh-toggle-btn osh-toggle-btn-active" : "osh-toggle-btn"}
              onClick={() => setHoldType("days")}
              disabled={busy}
            >
              Days
            </button>
          </div>

          {holdType === "amount" ? (
            <label className="osh-label">
              Amount to hold (₹)
              <input
                className="field"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
              />
            </label>
          ) : (
            <label className="osh-label">
              Number of days to hold
              <input
                className="field"
                type="number"
                min="0"
                step="1"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={busy}
              />
            </label>
          )}

          <label className="osh-label">
            Reason
            <textarea
              className="field"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="Explain why this hold is being placed"
            />
          </label>

          <button type="button" className="button" disabled={busy} onClick={submit}>
            {busy ? "Placing…" : "Place hold"}
          </button>
          {error && <p className="ooc-gate-error" role="alert">{error}</p>}
          {success && <p className="osh-success">{success}</p>}
        </div>
      )}
    </section>
  );
}

export function OpsSalaryHold({ initial }: { initial: SalaryHoldWorkspace }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/ops-pulse/salary-hold", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Salary hold workspace could not be refreshed.");
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Salary hold workspace could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }

  if (!data.designationTierCleared) {
    return (
      <div className="ooc">
        <section className="panel ooc-intro">
          <div>
            <span className="ooc-eyebrow">TEAM OPS · SALARY HOLD</span>
            <h1>Salary Hold</h1>
          </div>
        </section>
        <section className="panel">
          <p role="alert">
            You do not have the required designation tier to place salary holds. Only Senior Store Manager and above
            can place a salary hold; Station Manager, Store Manager and Team Lead cannot.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="ooc">
      <section className="panel ooc-intro">
        <div>
          <span className="ooc-eyebrow">TEAM OPS · SALARY HOLD</span>
          <h1>Salary Hold</h1>
          <p>Place a standing salary hold on a direct report, or request HR to cancel a hold you previously placed.</p>
        </div>
        <button className="button secondary" disabled={refreshing} onClick={refresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </section>
      {error && <p className="ooc-gate-error" role="alert">{error}</p>}

      <PlaceHoldForm workspace={data} onPlaced={refresh} />

      <section className="panel">
        <h2>Holds you have placed</h2>
        {data.holds.length === 0 && <p className="ooc-empty">You have not placed any salary holds yet.</p>}
        {data.holds.map((hold) => (
          <HoldRow key={hold.id} hold={hold} onActed={refresh} />
        ))}
      </section>
    </div>
  );
}
