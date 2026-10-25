"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StationClaim } from "@/lib/ops-pulse/station-claims";
import { CLAIM_CATEGORIES, CLAIM_STATUS, claimNoteError, validateClaim, type ClaimAction } from "@/lib/ops-pulse/station-claims-policy";
import type { LossSettings, NlCase, RecoveryOutcome } from "@/lib/ops-pulse/nl-loss-policy";
import { NlLossCases } from "./nl-loss-cases";
import styles from "./nl-loss.module.css";
import { ListPager, usePaged } from "./list-pager";

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0);
const day = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: d.length === 10 ? "UTC" : "Asia/Kolkata" }) : "");
const ACTION_LABEL: Record<ClaimAction, string> = { approve: "Approve", return: "Return for info", reject: "Reject", resubmit: "Resubmit", withdraw: "Withdraw" };
const FILTERS = [["open", "Open"], ["submitted", "Awaiting approval"], ["returned", "Returned"], ["approved", "Approved"], ["closed", "Closed"], ["all", "All"]] as const;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function post(body: unknown) {
  const res = await fetch("/api/ops-pulse/losses/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(j.error || "The claim could not be saved.");
  return j.message as string;
}

export function StationClaimsDesk({ claims, cases, outcomes, settings, stations, canRaise, canEdit, canRecovered }: {
  claims: StationClaim[]; cases: NlCase[]; outcomes: RecoveryOutcome[]; settings: LossSettings | null;
  stations: { id: string; station_code: string }[]; canRaise: boolean; canEdit: boolean; canRecovered: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>(claims.some((c) => c.actions.some((a) => a === "approve" || a === "resubmit")) ? "open" : "all");
  const [query, setQuery] = useState("");
  const [stationFilter, setStationFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [message, setMessage] = useState("");
  const done = (m: string) => { setMessage(m); router.refresh(); };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return claims.filter((c) =>
      (filter === "all" || (filter === "open" ? c.status === "submitted" || c.status === "returned" : filter === "closed" ? c.status === "rejected" || c.status === "withdrawn" : c.status === filter)) &&
      (!stationFilter || c.stationCode === stationFilter) &&
      (!q || [c.reference, c.stationCode, c.description, c.people].join(" ").toLowerCase().includes(q)));
  }, [claims, filter, query, stationFilter]);
  const paged = usePaged(shown, 25, `${filter}|${query}|${stationFilter}`);
  const claimStations = [...new Set(claims.map((c) => c.stationCode))].sort();
  const mine = claims.filter((c) => c.actions.some((a) => a !== "withdraw")).length;
  const sum = (s: string) => claims.filter((c) => c.status === s).reduce((n, c) => n + c.amount, 0);
  const caseByKey = new Map(cases.map((c) => [c.case_key, c]));
  const unassigned = cases.filter((c) => !c.recovery || c.recovery.is_deleted);

  return (
    <>
      <div className={`${styles.metrics} ${styles.metrics4}`}>
        <div><span>Needs your action</span><strong>{mine}</strong><small>Decide, or resubmit what was returned</small></div>
        <div><span>Awaiting final approval</span><strong>{money(sum("submitted"))}</strong><small>{claims.filter((c) => c.status === "submitted").length} claims waiting</small></div>
        <div><span>Approved</span><strong>{money(sum("approved"))}</strong><small>{unassigned.length ? `${unassigned.length} still to assign to people` : "All assigned for recovery"}</small></div>
        <div><span>Returned to stations</span><strong>{claims.filter((c) => c.status === "returned").length}</strong><small>Waiting for more information</small></div>
      </div>
      {message ? <p className={styles.done} role="status">{message}</p> : null}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h2>Station loss claims</h2>
            <p>Station raises → authorised final approver reviews → recovery proposal → collection.</p>
          </div>
          <div className={styles.toolbar}>
            <input aria-label="Search claims" placeholder="Reference, station, description" value={query} onChange={(e) => setQuery(e.target.value)} />
            {claimStations.length > 1 ? <select aria-label="Station" value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}><option value="">All stations</option>{claimStations.map((c) => <option key={c} value={c}>{c}</option>)}</select> : null}
            {canRaise ? <button className={styles.primary} onClick={() => setRaising((v) => !v)}>{raising ? "Close" : "Raise a claim"}</button> : null}
          </div>
        </div>
        {raising ? <RaiseClaim stations={stations} onDone={(m) => { setRaising(false); done(m); }} /> : null}
        <div className={styles.chips} role="tablist">
          {FILTERS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? `${styles.chip} ${styles.activeChip}` : styles.chip} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        {shown.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.ledgerTable}>
              <thead><tr><th>Claim</th><th>Station</th><th>Incident</th><th className={styles.num}>Amount</th><th>Status · next step</th><th /></tr></thead>
              <tbody>
                {paged.rows.map((c) => {
                  const meta = CLAIM_STATUS[c.status];
                  const linked = c.caseKey ? caseByKey.get(c.caseKey) : undefined;
                  const assigned = linked?.recovery && !linked.recovery.is_deleted;
                  return [
                    <tr key={c.id}>
                      <td><strong>{c.reference}</strong><small>{CLAIM_CATEGORIES[c.category]} · by {c.raisedByName} · {day(c.raisedAt)}</small></td>
                      <td>{c.stationCode}</td>
                      <td>{day(c.incidentDate)}</td>
                      <td className={styles.num}><strong>{money(c.amount)}</strong></td>
                      <td>
                        <span className={`${styles.statusPill} ${styles[`tone_${meta.tone}`]}`}>{meta.label}</span>
                        <small>{c.status === "approved" ? (assigned ? `Recovering · ${linked!.recovery!.outcome_label}` : "Assign people for recovery") : meta.next}{c.status === "submitted" && c.approverNames.length ? ` · ${c.approverNames.join(", ")}` : ""}{c.status === "submitted" && !c.approverNames.length ? " · final approver required" : ""}</small>
                      </td>
                      <td><button className={styles.button} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : c.actions.length ? "Open · act" : "Open"}</button></td>
                    </tr>,
                    open === c.id ? (
                      <tr key={`${c.id}-d`}><td colSpan={6} className={styles.wrap}><ClaimDetail claim={c} onDone={done} /></td></tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="claims" />
          </div>
        ) : (
          <p className={styles.empty}>{claims.length ? "No claims match this view." : "No station loss claims yet."}</p>
        )}
      </section>
      {cases.length ? (
        <NlLossCases cases={cases} outcomes={outcomes} settings={settings} canEdit={canEdit} canRecovered={canRecovered} />
      ) : null}
    </>
  );
}

function ClaimDetail({ claim, onDone }: { claim: StationClaim; onDone: (m: string) => void }) {
  const [action, setAction] = useState<ClaimAction | null>(null);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(String(claim.amount));
  const [description, setDescription] = useState(claim.description);
  const [evidence, setEvidence] = useState(claim.evidenceUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (!action) return;
    const bad = claimNoteError(action, note);
    if (bad) return setError(bad);
    setBusy(true); setError("");
    try {
      onDone(await post({ claimId: claim.id, action, version: claim.version, note, amount, description, evidenceUrl: evidence }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setBusy(false); }
  }
  return (
    <div className={styles.desk} style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
      <p className={styles.sourceNote}>{claim.description}</p>
      <div className={styles.toolbar} style={{ justifyContent: "flex-start" }}>
        {claim.people ? <span className={styles.hint}>People involved: {claim.people}</span> : null}
        {claim.evidenceUrl ? <a href={claim.evidenceUrl} target="_blank" rel="noreferrer">Evidence</a> : <span className={styles.hint}>No evidence link</span>}
        {claim.decisionNote ? <span className={styles.hint}>{claim.decidedByName}: “{claim.decisionNote}”</span> : null}
      </div>
      {claim.actions.length ? (
        action ? (
          <div className={styles.override}>
            <strong>{ACTION_LABEL[action]}</strong>
            {action === "resubmit" ? (
              <div className={styles.planRow}>
                <label>Amount (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
                <label>Evidence link<input type="url" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://" /></label>
              </div>
            ) : null}
            {action === "resubmit" ? <label>Description<textarea rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></label> : null}
            <label>{action === "reject" || action === "return" ? "Reason (required)" : "Note (optional)"}<textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {action === "approve" ? <p className={styles.hint}>Approving opens a Team Ops loss case of {money(claim.amount)}; assign the people responsible in the recovery panel below.</p> : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.dialogActions} style={{ justifyContent: "flex-start" }}>
              <button className={styles.primary} disabled={busy} onClick={submit}>{busy ? "Saving…" : `Confirm · ${ACTION_LABEL[action]}`}</button>
              <button className={styles.button} disabled={busy} onClick={() => { setAction(null); setError(""); }}>Back</button>
            </div>
          </div>
        ) : (
          <div className={styles.toolbar} style={{ justifyContent: "flex-start" }}>
            {claim.actions.map((a) => <button key={a} className={a === "approve" || a === "resubmit" ? styles.primary : styles.button} onClick={() => setAction(a)}>{ACTION_LABEL[a]}</button>)}
          </div>
        )
      ) : null}
      {claim.history.length ? (
        <details className={styles.history}>
          <summary>History · {claim.history.length}</summary>
          {claim.history.map((h, i) => (
            <div key={i}><strong>{h.action} · {h.actorName ?? "System"}</strong><small>{new Date(h.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small>{h.note ? <p>{h.note}</p> : null}</div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function RaiseClaim({ stations, onDone }: { stations: { id: string; station_code: string }[]; onDone: (m: string) => void }) {
  const [f, setF] = useState({ stationId: stations.length === 1 ? stations[0].id : "", reference: "", incidentDate: today(), category: "cash_shortage", amount: "", description: "", evidenceUrl: "", people: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const bad = validateClaim(f);
    if (bad) return setError(bad);
    setBusy(true); setError("");
    try { onDone(await post({ kind: "raise", ...f })); } catch (err) { setError(err instanceof Error ? err.message : "Could not raise."); } finally { setBusy(false); }
  }
  return (
    <form className={styles.allocation} style={{ margin: "0 20px 16px" }} onSubmit={submit}>
      <div className={styles.formGrid}>
        <label>Station<select value={f.stationId} onChange={set("stationId")} required><option value="">Choose</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.station_code}</option>)}</select></label>
        <label>Reference<input value={f.reference} onChange={set("reference")} placeholder="BLR1-CASH-0416" maxLength={60} required /></label>
        <label>Incident date<input type="date" value={f.incidentDate} max={today()} onChange={set("incidentDate")} required /></label>
        <label>Category<select value={f.category} onChange={set("category")}>{Object.entries(CLAIM_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Amount (₹)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={f.amount} onChange={set("amount")} required /></label>
        <label>Evidence link (optional)<input type="url" value={f.evidenceUrl} onChange={set("evidenceUrl")} placeholder="https://drive.google.com/…" /></label>
      </div>
      <label>What happened<textarea rows={3} maxLength={2000} value={f.description} onChange={set("description")} placeholder="Describe the loss, how it was found and what supports it." required /></label>
      <label>People involved (optional)<input value={f.people} onChange={set("people")} maxLength={500} placeholder="Names or IDs; the CM assigns the final responsibility" /></label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div><button className={styles.primary} disabled={busy}>{busy ? "Raising…" : "Send to cluster manager"}</button></div>
    </form>
  );
}
