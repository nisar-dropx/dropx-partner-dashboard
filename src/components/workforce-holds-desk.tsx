"use client";
import { useState } from "react";
import type { WorkforceHoldAction, WorkforceHoldRequest, WorkforceHoldStatus, WorkforceHoldWorkspace } from "@/lib/ops-pulse/workforce-hold-data";
import styles from "./ops-salary-hold.module.css";

const STATUS: Record<WorkforceHoldStatus, { label: string; tone: string }> = {
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  active: { label: "Payment on hold", tone: "danger" },
  release_requested: { label: "Release requested", tone: "warn" },
  released: { label: "Released", tone: "good" },
  rejected: { label: "Rejected", tone: "muted" },
  cancelled: { label: "Withdrawn", tone: "muted" },
};
const ACTION: Record<WorkforceHoldAction, { label: string; note: boolean; cls: string }> = {
  approve: { label: "Approve hold", note: false, cls: "primary" },
  reject: { label: "Reject", note: true, cls: "danger" },
  withdraw: { label: "Withdraw", note: false, cls: "secondary" },
  request_release: { label: "Request release", note: true, cls: "secondary" },
  approve_release: { label: "Approve release", note: false, cls: "primary" },
  reject_release: { label: "Keep on hold", note: true, cls: "danger" },
};
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const when = (v: string) => new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function months() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return [-3, -2, -1, 0, 1].map((o) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + o, 1)); return d.toISOString().slice(0, 7); }).reverse();
}

async function post(body: unknown) {
  const r = await fetch("/api/ops-pulse/workforce-holds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Could not save.");
  return j.message as string;
}

function RequestCard({ r, onDone }: { r: WorkforceHoldRequest; onDone: (m: string) => void }) {
  const [action, setAction] = useState<WorkforceHoldAction | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = STATUS[r.status];
  async function submit() {
    if (!action) return;
    if (ACTION[action].note && note.trim().length < 5) return setError("Add a reason (at least 5 characters).");
    setBusy(true); setError("");
    try { onDone(await post({ requestId: r.id, action, version: r.version, note })); setAction(null); setNote(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }
  return (
    <article className={styles.hold}>
      <div className={styles.holdHead}>
        <div><strong>{r.name}</strong><small>{[r.dropxId, r.stationCode, monthLabel(r.month)].filter(Boolean).join(" · ")}</small></div>
        <span className={`${styles.pill} ${styles[`tone_${s.tone}`]}`}>{s.label}</span>
      </div>
      <p className={styles.reason}>{r.reason}</p>
      <div className={styles.facts}>
        <span>Raised by <b>{r.raisedByName}</b> · {when(r.raisedAt)}</span>
        {r.decidedByName ? <span>Decided by <b>{r.decidedByName}</b></span> : null}
        {r.releasedByName ? <span>Released by <b>{r.releasedByName}</b></span> : null}
      </div>
      {(r.status === "awaiting_approval" || r.status === "release_requested") ? (
        <p className={styles.next}>{r.status === "awaiting_approval" ? "Cluster manager to approve" : "Cluster manager to approve the release"}{r.approverNames.length ? ` · ${r.approverNames.join(", ")}` : " · no cluster manager mapped in People"}</p>
      ) : null}
      {r.actions.length ? (action ? (
        <div className={styles.decide}>
          <strong>{ACTION[action].label}</strong>
          <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={ACTION[action].note ? "Reason (required)" : "Note (optional)"} />
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button className={styles[ACTION[action].cls]} disabled={busy} onClick={submit}>{busy ? "Saving…" : `Confirm · ${ACTION[action].label}`}</button>
            <button className={styles.secondary} disabled={busy} onClick={() => { setAction(null); setError(""); }}>Back</button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>{r.actions.map((a) => <button key={a} className={styles[ACTION[a].cls]} onClick={() => setAction(a)}>{ACTION[a].label}</button>)}</div>
      )) : null}
      {r.history.length ? <details><summary className={styles.hint}>History · {r.history.length}</summary><ol className={styles.timeline}>{r.history.map((h, i) => <li key={i}><b>{h.action.replace(/_/g, " ")}</b>{h.actorName ? ` by ${h.actorName}` : ""}<time>{when(h.createdAt)}</time>{h.note ? <div>{h.note}</div> : null}</li>)}</ol></details> : null}
    </article>
  );
}

function RaiseForm({ ws, onDone }: { ws: WorkforceHoldWorkspace; onDone: (m: string) => void }) {
  const [station, setStation] = useState(ws.stations.length === 1 ? ws.stations[0].id : "");
  const [people, setPeople] = useState<Array<{ workforceId: string; name: string; dropxId: string | null }> | null>(null);
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState("");
  const [month, setMonth] = useState(months()[1]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(id: string) {
    setStation(id); setPeople(null); setPick("");
    if (!id) return;
    try {
      const r = await fetch(`/api/ops-pulse/workforce-holds?station=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setPeople(j.people);
    } catch (e) { setError(e instanceof Error ? e.message : "Associates could not be loaded."); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pick) return setError("Choose the associate.");
    if (reason.trim().length < 5) return setError("Explain the reason (at least 5 characters).");
    setBusy(true); setError("");
    try { onDone(await post({ kind: "raise", workforceId: pick, month, reason })); setPick(""); setReason(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not raise."); }
    finally { setBusy(false); }
  }
  const q = search.trim().toLowerCase();
  const list = (people ?? []).filter((p) => !q || `${p.name} ${p.dropxId ?? ""}`.toLowerCase().includes(q)).slice(0, 80);
  if (!ws.canRaise) return <section className={styles.card}><h2>Hold a Workforce payment</h2><p className={styles.hint}>You can view holds. Raising one needs Salary Hold edit access.</p></section>;
  return (
    <form className={styles.card} onSubmit={submit}>
      <h2>Hold a Workforce payment</h2>
      <p className={styles.hint}>Blocks the associate&apos;s payout for one month — nothing is deducted. It takes effect when the station&apos;s cluster manager approves.</p>
      <label>Station<select value={station} onChange={(e) => void load(e.target.value)}><option value="">Choose a station…</option>{ws.stations.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
      {people ? (
        <label>Associate
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${people.length} associates`} />
          <div className={styles.people} role="listbox">
            {list.map((p) => <button type="button" role="option" aria-selected={pick === p.workforceId} key={p.workforceId} className={pick === p.workforceId ? styles.personOn : styles.person} onClick={() => setPick(p.workforceId)}><b>{p.name}</b><small>{p.dropxId ?? "ID pending"}</small></button>)}
            {!list.length ? <small className={styles.hint}>{people.length ? "No one matches." : "No associates at this station."}</small> : null}
          </div>
        </label>
      ) : null}
      <label>Payout month<select value={month} onChange={(e) => setMonth(e.target.value)}>{months().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      <label>Reason<textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the payment should wait" /></label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className={styles.primary} disabled={busy || !pick}>{busy ? "Raising…" : "Send for approval"}</button>
    </form>
  );
}

export function WorkforceHoldsDesk({ initial }: { initial: WorkforceHoldWorkspace }) {
  const [ws, setWs] = useState(initial);
  const [tab, setTab] = useState<"action" | "live" | "all">(initial.requests.some((r) => r.actions.length) ? "action" : "live");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function refresh(m = "") {
    setMessage(m); setError("");
    try { const r = await fetch("/api/ops-pulse/workforce-holds", { cache: "no-store" }); const j = await r.json(); if (!r.ok) throw new Error(j.error); setWs(j); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not refresh."); }
  }
  const action = ws.requests.filter((r) => r.actions.length);
  return (
    <div className={styles.desk}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>TEAM OPS · WORKFORCE</span>
          <h1>Workforce payment holds</h1>
          <p>Hold an associate&apos;s payout for a month with a reason. The station&apos;s cluster manager approves it, the payout and bank file then skip that month, and releasing it is approved the same way.</p>
        </div>
        <div className={styles.flow} aria-label="Workflow"><span>Raised</span><i>→</i><span>CM approves</span><i>→</i><span>Payment on hold</span><i>→</i><span>Release approved</span></div>
      </header>
      {message ? <p className={styles.success} role="status">{message}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.grid}>
        <RaiseForm ws={ws} onDone={(m) => void refresh(m)} />
        <section className={styles.list}>
          <div className={styles.tabs} role="tablist">
            {([["action", "Needs action", action.length], ["live", "On hold now", ws.live.length], ["all", "All requests", ws.requests.length]] as const).map(([k, l, n]) => (
              <button key={k} role="tab" className={styles.tab} aria-selected={tab === k} onClick={() => setTab(k)}>{l}<span className={styles.count}>{n}</span></button>
            ))}
          </div>
          {tab === "live" ? (ws.live.length ? ws.live.map((h) => (
            <article className={styles.hold} key={`${h.workforceId}|${h.month}`}>
              <div className={styles.holdHead}><div><strong>{h.name}</strong><small>{[h.dropxId, h.stationCode, monthLabel(h.month)].filter(Boolean).join(" · ")}</small></div><span className={`${styles.pill} ${styles.tone_danger}`}>On hold</span></div>
              <p className={styles.reason}>{h.remarks}</p>
              <small className={styles.hint}>Since {when(h.since)} · {h.viaRequest ? "approved here" : "placed from Payments → Workforce payouts"}</small>
            </article>
          )) : <p className={styles.empty}>No Workforce payment is on hold in your stations.</p>)
            : ((tab === "action" ? action : ws.requests).length ? (tab === "action" ? action : ws.requests).map((r) => <RequestCard key={r.id} r={r} onDone={(m) => void refresh(m)} />)
              : <p className={styles.empty}>{tab === "action" ? "Nothing waits for you." : "No hold requests yet."}</p>)}
        </section>
      </div>
    </div>
  );
}
