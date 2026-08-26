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
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/advances?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load advance requests.");
      setRows(payload.requests ?? []);
      setEligibleForAdvance(payload.account?.eligibleForAdvance === true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load advance requests."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/advances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, amount, purpose })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit advance request.");
      setAmount(""); setPurpose(""); setShowForm(false); setNotice("Advance request submitted.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit advance request."); }
    finally { setSaving(false); }
  }

  return <section className="dx-advances">
    <header><div className="dx-advance-title"><i><IndianRupee /></i><h1>Advances</h1></div><button disabled={!eligibleForAdvance || loading} onClick={() => setShowForm(true)}><Plus />New request</button></header>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    {!loading && !eligibleForAdvance ? <div className="dx-alert info">Advance requests are available only when Profile status is Active.</div> : null}
    {loading ? <div className="dx-loader"><span /><small>Loading advances...</small></div> : rows.length ? <div className="dx-advance-list">
      {rows.map((row) => <article key={row.id}>
        <div><strong>{money(Number(row.amount))}</strong><span className={`status ${row.status}`}>{label(row.status)}</span></div>
        <p>{row.purpose}</p>
        <dl><div><dt>Requested on</dt><dd>{new Date(row.requested_at).toLocaleString("en-IN")}</dd></div>{row.approved_amount != null ? <div><dt>Approved amount</dt><dd>{money(Number(row.approved_amount))}</dd></div> : null}{row.decision_comment ? <div><dt>Comment</dt><dd>{row.decision_comment}</dd></div> : null}<div><dt>Updated on</dt><dd>{new Date(row.updated_at).toLocaleString("en-IN")}</dd></div></dl>
      </article>)}
    </div> : <div className="dx-advance-empty"><IndianRupee /><strong>No advance requests yet</strong><small>Your submitted requests will appear here.</small></div>}
    {showForm ? <div className="dx-advance-modal"><button aria-label="Close" className="backdrop" onClick={() => setShowForm(false)} /><form onSubmit={submit}><header><h2>Advance request</h2><button aria-label="Close" onClick={() => setShowForm(false)} type="button"><X /></button></header><label>Required amount<input autoFocus inputMode="decimal" min="1" onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required step="0.01" type="number" value={amount} /></label><label>Purpose<textarea maxLength={500} minLength={3} onChange={(event) => setPurpose(event.target.value)} required rows={4} value={purpose} /></label><button className="submit" disabled={saving} type="submit">{saving ? "Submitting..." : "Submit request"}</button></form></div> : null}
  </section>;
}
