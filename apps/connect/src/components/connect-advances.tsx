"use client";

import { ChevronDown, IndianRupee, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useKeepAliveRefresh } from "../lib/use-keep-alive-refresh";

type Account = { id: string; profileType: string; reference?: string | null; name?: string | null; role?: string | null; workspace?: "people" | "workforce" };
type AdvanceRequest = {
  id: string;
  reference?: string | null;
  source?: "ops" | "payroll";
  amount: number;
  purpose: string;
  status: string;
  approved_amount?: number | null;
  decision_comment?: string | null;
  requested_at: string;
  updated_at: string;
  canWithdraw?: boolean;
  maxEligibleAmount?: number | null;
  outstandingPay?: number | null;
  recovery?: string | null;
  installments?: number | null;
  steps?: Array<{ stepName: string; status: string; note?: string | null }>;
};

type AdvanceCapacity = {
  outstandingPay: number;
  committedAdvance: number;
  eligibilityPercent: number;
  maxEligibleAmount: number;
};

function money(value: number | null | undefined) {
  return value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

function label(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatWhen(value: string) {
  return new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata"
  });
}

export function ConnectAdvances({ account, active = true }: { account: Account; active?: boolean }) {
  const workforce = account.workspace === "workforce";
  const [rows, setRows] = useState<AdvanceRequest[]>([]);
  const [eligibleForAdvance, setEligibleForAdvance] = useState<boolean | null>(null);
  const [capacity, setCapacity] = useState<AdvanceCapacity>({ outstandingPay: 0, committedAdvance: 0, eligibilityPercent: 25, maxEligibleAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [withdrawingId, setWithdrawingId] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const { markLoaded, setReload } = useKeepAliveRefresh(active);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/advances?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load advance requests.");
      if (typeof payload.account?.eligibleForAdvance !== "boolean") {
        throw new Error("Unable to verify advance eligibility. Please retry shortly.");
      }
      setRows(payload.requests ?? []);
      setEligibleForAdvance(payload.account?.eligibleForAdvance === true);
      setCapacity({
        outstandingPay: Number(payload.account?.outstandingPay ?? 0),
        committedAdvance: Number(payload.account?.committedAdvance ?? 0),
        eligibilityPercent: Number(payload.account?.eligibilityPercent ?? 25),
        maxEligibleAmount: Number(payload.account?.maxEligibleAmount ?? 0)
      });
    } catch (reason) {
      setEligibleForAdvance(null);
      setError(reason instanceof Error ? reason.message : "Unable to load advance requests.");
    } finally {
      if (!background) setLoading(false);
      markLoaded();
    }
  }, [account.id, account.profileType, markLoaded]);
  setReload(() => load(true));

  useEffect(() => {
    void load();
  }, [load]);

  function closeForm() {
    if (saving) return;
    setShowForm(false);
    setAmount("");
    setPurpose("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          amount,
          purpose
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit advance request.");
      setAmount("");
      setPurpose("");
      setShowForm(false);
      setNotice(payload.notice || "Advance request submitted.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to submit advance request.");
    } finally {
      setSaving(false);
    }
  }

  async function withdraw(requestId: string) {
    if (withdrawingId) return;
    setWithdrawingId(requestId);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/advances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to withdraw advance request.");
      setNotice(payload.notice || "Advance request withdrawn.");
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to withdraw advance request.";
      setError(message);
      // The request was likely actioned elsewhere between page load and this click;
      // refresh so the stale row's status/withdraw button catch up instead of staying stuck.
      if (message.includes("already been decided")) await load(true);
    } finally {
      setWithdrawingId("");
    }
  }

  function toggleDetails(requestId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  return (
    <section className="dx-advances">
      <header className="dx-page-intro dx-advance-intro">
        <div className="dx-advance-title">
          <i aria-hidden="true"><IndianRupee /></i>
          <span>
            <small className="dx-page-eyebrow">My pay</small>
            <h1>Advances</h1>
            <p>{workforce ? "Request and track payment advances." : "Request and track salary advances."}</p>
          </span>
        </div>
        <button disabled={!eligibleForAdvance || loading || capacity.maxEligibleAmount < 500} onClick={() => setShowForm(true)} type="button">
          <Plus />
          New request
        </button>
      </header>

      {error ? <div className="dx-alert error">{error}</div> : null}
      {notice ? <div className="dx-alert success">{notice}</div> : null}
      {!loading && !error && eligibleForAdvance === false ? (
        <div className="dx-alert info">Advance requests are available only when Profile status is Active.</div>
      ) : null}
      {!loading && !error && eligibleForAdvance ? (
        <div className="dx-advance-capacity" aria-label="Advance eligibility">
          <div><small>Outstanding pay</small><strong>{money(capacity.outstandingPay)}</strong></div>
          <div><small>Maximum request · {capacity.eligibilityPercent}%</small><strong>{money(capacity.maxEligibleAmount)}</strong></div>
          {capacity.committedAdvance > 0 ? <div><small>Already committed</small><strong>{money(capacity.committedAdvance)}</strong></div> : null}
        </div>
      ) : null}
      {!loading && !error && eligibleForAdvance && capacity.maxEligibleAmount < 500 ? (
        <div className="dx-alert info">No request is available right now. The minimum is ₹500 and the limit is based on 25% of unpaid and accrued pay.</div>
      ) : null}

      {loading ? (
        <div className="dx-loader"><span /><small>Loading advances…</small></div>
      ) : rows.length ? (
        <div className="dx-advance-list">
          {rows.map((row) => {
            const expanded = expandedIds.has(row.id);
            const detailId = `advance-details-${row.id}`;
            return <article className={expanded ? "expanded" : ""} key={row.id}>
              <button
                aria-controls={detailId}
                aria-expanded={expanded}
                className="dx-advance-card-head"
                onClick={() => toggleDetails(row.id)}
                type="button"
              >
                <span>
                  <small>{row.reference || `ADV-${row.id.slice(0, 8).toUpperCase()}`}</small>
                  <strong>{money(Number(row.amount))}</strong>
                  <em>Requested {formatDate(row.requested_at)}</em>
                </span>
                <span className="dx-advance-card-state">
                  <b className={`status ${row.status}`}>{label(row.status)}</b>
                  <ChevronDown aria-hidden="true" />
                </span>
              </button>
              {expanded ? <div className="dx-advance-card-details" id={detailId}>
                <section>
                  <small>Request details</small>
                  <p>{row.purpose}</p>
                  <dl>
                    <div><dt>Request ID</dt><dd>{row.reference || row.id}</dd></div>
                    <div><dt>Submitted</dt><dd>{formatWhen(row.requested_at)}</dd></div>
                    {row.approved_amount != null ? <div><dt>Approved</dt><dd>{money(Number(row.approved_amount))}</dd></div> : null}
                    {row.recovery ? <div><dt>Recovery</dt><dd>{label(row.recovery)}{row.installments && row.installments > 1 ? ` · ${row.installments} instalments` : ""}</dd></div> : null}
                    {row.decision_comment ? <div><dt>{row.status === "returned" ? "Return reason" : "Reviewer note"}</dt><dd>{row.decision_comment}</dd></div> : null}
                    <div><dt>Last updated</dt><dd>{formatWhen(row.updated_at)}</dd></div>
                  </dl>
                </section>
                {row.steps?.length ? <section className="dx-advance-lifecycle">
                  <small>Approval lifecycle</small>
                  <ol className="dx-advance-journey">
                    {row.steps.map((step, index) => <li className={step.status} key={`${step.stepName}:${index}`}>
                      <span>{index + 1}</span>
                      <div><strong>{step.stepName}</strong><small>{label(step.status)}</small>{step.note ? <p>{step.note}</p> : null}</div>
                    </li>)}
                  </ol>
                </section> : null}
                {row.canWithdraw !== false && ["submitted", "in_review"].includes(row.status) ? (
                  <button className="dx-advance-withdraw" disabled={withdrawingId === row.id} onClick={() => void withdraw(row.id)} type="button">
                    {withdrawingId === row.id ? "Withdrawing…" : "Withdraw request"}
                  </button>
                ) : null}
              </div> : null}
            </article>;
          })}
        </div>
      ) : (
        <div className="dx-advance-empty">
          <IndianRupee />
          <strong>No advance requests yet</strong>
          <small>Your submitted requests will appear here.</small>
        </div>
      )}

      {showForm ? (
        <div className="dx-advance-modal" role="dialog" aria-modal="true" aria-labelledby="dx-advance-request-title">
          <button aria-label="Close" className="backdrop" onClick={closeForm} type="button" />
          <form onSubmit={submit}>
            <header>
              <div>
                <small>My pay</small>
                <h2 id="dx-advance-request-title">Advance request</h2>
                <p>Enter the amount you need and a short purpose.</p>
              </div>
              <button aria-label="Close" onClick={closeForm} type="button"><X /></button>
            </header>
            <label>
              Required amount
              <input
                autoFocus
                inputMode="decimal"
                min="500"
                max={capacity.maxEligibleAmount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                required
                step="0.01"
                type="number"
                value={amount}
              />
            </label>
            <label>
              Purpose
              <textarea
                maxLength={500}
                minLength={10}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Why do you need this advance?"
                required
                rows={4}
                value={purpose}
              />
            </label>
            <div className="dx-advance-modal-actions">
              <button className="ghost" disabled={saving} onClick={closeForm} type="button">Cancel</button>
              <button className="submit" disabled={saving || purpose.trim().length < 10 || !amount || Number(amount) > capacity.maxEligibleAmount} type="submit">
                {saving ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
