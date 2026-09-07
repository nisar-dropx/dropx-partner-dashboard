"use client";

import { IndianRupee, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Account = { id: string; profileType: string; reference?: string | null; name?: string | null; role?: string | null };
type AdvanceRequest = {
  id: string;
  amount: number;
  purpose: string;
  status: string;
  approved_amount?: number | null;
  decision_comment?: string | null;
  requested_at: string;
  updated_at: string;
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

export function ConnectAdvances({ account }: { account: Account }) {
  const [rows, setRows] = useState<AdvanceRequest[]>([]);
  const [eligibleForAdvance, setEligibleForAdvance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/advances?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load advance requests.");
      setRows(payload.requests ?? []);
      setEligibleForAdvance(payload.account?.eligibleForAdvance === true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load advance requests.");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.profileType]);

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

  return (
    <section className="dx-advances">
      <header className="dx-page-intro dx-advance-intro">
        <div className="dx-advance-title">
          <i aria-hidden="true"><IndianRupee /></i>
          <span>
            <small className="dx-page-eyebrow">My pay</small>
            <h1>Advances</h1>
            <p>Request and track salary advances.</p>
          </span>
        </div>
        <button disabled={!eligibleForAdvance || loading} onClick={() => setShowForm(true)} type="button">
          <Plus />
          New request
        </button>
      </header>

      {error ? <div className="dx-alert error">{error}</div> : null}
      {notice ? <div className="dx-alert success">{notice}</div> : null}
      {!loading && !eligibleForAdvance ? (
        <div className="dx-alert info">Advance requests are available only when Profile status is Active.</div>
      ) : null}

      {loading ? (
        <div className="dx-loader"><span /><small>Loading advances…</small></div>
      ) : rows.length ? (
        <div className="dx-advance-list">
          {rows.map((row) => (
            <article key={row.id}>
              <div className="dx-advance-card-head">
                <strong>{money(Number(row.amount))}</strong>
                <span className={`status ${row.status}`}>{label(row.status)}</span>
              </div>
              <p>{row.purpose}</p>
              <dl>
                <div>
                  <dt>Requested</dt>
                  <dd>{formatWhen(row.requested_at)}</dd>
                </div>
                {row.approved_amount != null ? (
                  <div>
                    <dt>Approved</dt>
                    <dd>{money(Number(row.approved_amount))}</dd>
                  </div>
                ) : null}
                {row.decision_comment ? (
                  <div>
                    <dt>Comment</dt>
                    <dd>{row.decision_comment}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Updated</dt>
                  <dd>{formatWhen(row.updated_at)}</dd>
                </div>
              </dl>
            </article>
          ))}
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
                min="1"
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
                minLength={3}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Why do you need this advance?"
                required
                rows={4}
                value={purpose}
              />
            </label>
            <div className="dx-advance-modal-actions">
              <button className="ghost" disabled={saving} onClick={closeForm} type="button">Cancel</button>
              <button className="submit" disabled={saving || purpose.trim().length < 3 || !amount} type="submit">
                {saving ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
