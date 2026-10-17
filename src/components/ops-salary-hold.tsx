"use client";
import { useState, useTransition } from "react";
import { actOnSalaryHold, placeSalaryHold } from "@/app/ops-pulse/attendance/salary-hold/actions";
import type { SalaryHoldRecord, SalaryHoldWorkspace } from "@/lib/ops-pulse/salary-hold-data";
import { ACTION_COPY, HOLD_STATUS, noteError, validateRaise, type SalaryHoldAction } from "@/lib/ops-pulse/salary-hold-policy";
import styles from "./ops-salary-hold.module.css";

const money = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0);
const when = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
const EVENT_LABEL: Record<string, string> = {
  raised: "Raised", approve: "Approved", reject: "Rejected", withdraw: "Withdrawn", request_cancel: "Cancellation requested",
  approve_cancel: "Cancellation approved", reject_cancel: "Cancellation declined", applied: "Withheld in payroll",
  request_release: "Release requested", approve_release: "Release approved", reject_release: "Release declined", paid_back: "Paid back",
};

function HoldCard({ hold, onDone }: { hold: SalaryHoldRecord; onDone: (message: string) => void }) {
  const [action, setAction] = useState<SalaryHoldAction | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const meta = HOLD_STATUS[hold.status];
  const shown = hold.holdType === "amount" ? money(hold.amount) : `${hold.days} day${hold.days === 1 ? "" : "s"}`;
  function submit() {
    if (!action) return;
    const invalid = noteError(action, note);
    if (invalid) return setError(invalid);
    const form = new FormData();
    form.set("holdId", hold.id);
    form.set("action", action);
    form.set("version", String(hold.version));
    form.set("note", note.trim());
    setError("");
    start(async () => {
      const result = await actOnSalaryHold(form);
      if (!result.ok) return setError(result.message);
      setAction(null);
      setNote("");
      onDone(result.message);
    });
  }
  return (
    <article className={styles.hold}>
      <div className={styles.holdHead}>
        <div>
          <strong>{hold.workerName}</strong>
          <small>
            {[hold.workerCode, hold.stationCode, hold.workerType === "contractor" ? "Contractor" : "Employee"].filter(Boolean).join(" · ")}
          </small>
        </div>
        <div>
          <div className={styles.amount}>{shown}</div>
          <span className={`${styles.pill} ${styles[`tone_${meta.tone}`]}`}>{meta.label}</span>
        </div>
      </div>
      <p className={styles.reason}>{hold.reason}</p>
      <div className={styles.facts}>
        <span>Raised by <b>{hold.requestedByName || "—"}</b> · {when(hold.requestedAt)}</span>
        {hold.decidedByName ? <span>Decided by <b>{hold.decidedByName}</b> · {when(hold.decidedAt)}</span> : null}
        {hold.appliedAmount != null ? <span>Withheld <b>{money(hold.appliedAmount)}</b></span> : null}
        {hold.status === "released" ? <span>{hold.paidBack ? "Paid back" : "Pays back in the next payroll"} <b>{money(hold.releaseAmount)}</b></span> : null}
      </div>
      {["awaiting_approval", "cancel_requested", "release_requested"].includes(hold.status) ? (
        <p className={styles.next}>
          {meta.next}
          {hold.approverNames.length ? ` · ${hold.approverNames.join(", ")}${hold.approverLevel === "aom" ? " (AOM, no cluster manager mapped)" : ""}` : " · No cluster manager is mapped to this station in People. Ask HR to map one."}
        </p>
      ) : null}
      {hold.actions.length ? (
        action ? (
          <div className={styles.decide}>
            <strong>{ACTION_COPY[action].label}</strong>
            <p className={styles.hint}>{ACTION_COPY[action].confirm}</p>
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={ACTION_COPY[action].noteRequired ? "Reason (required)" : "Note (optional)"} aria-label="Note" />
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <button className={styles[ACTION_COPY[action].tone]} disabled={busy} onClick={submit}>{busy ? "Saving…" : `Confirm · ${ACTION_COPY[action].label}`}</button>
              <button className={styles.secondary} disabled={busy} onClick={() => { setAction(null); setError(""); }}>Back</button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            {hold.actions.map((a) => (
              <button key={a} className={styles[ACTION_COPY[a].tone]} onClick={() => setAction(a)}>{ACTION_COPY[a].label}</button>
            ))}
          </div>
        )
      ) : null}
      {hold.history.length ? (
        <details>
          <summary className={styles.hint}>History · {hold.history.length}</summary>
          <ol className={styles.timeline}>
            {hold.history.map((e, i) => (
              <li key={i}>
                <b>{EVENT_LABEL[e.action] ?? e.action}</b>{e.actorName ? ` by ${e.actorName}` : ""}<time>{when(e.createdAt)}</time>
                {e.note ? <div>{e.note}</div> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

type Target = { workerType: "employee" | "contractor"; workerId: string; displayName: string; detail: string };

function RaiseForm({ workspace, onDone }: { workspace: SalaryHoldWorkspace; onDone: (message: string) => void }) {
  const [source, setSource] = useState<"team" | "station">(workspace.eligibleWorkers.length ? "team" : "station");
  const [stationId, setStationId] = useState(workspace.stations.length === 1 ? workspace.stations[0].id : "");
  const [stationPeople, setStationPeople] = useState<Target[] | null>(null);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [search, setSearch] = useState("");
  const [workerKey, setWorkerKey] = useState("");
  const [holdType, setHoldType] = useState<"amount" | "days">("amount");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const team: Target[] = workspace.eligibleWorkers.map((w) => ({ workerType: w.workerType, workerId: w.workerId, displayName: w.displayName, detail: w.designationName ?? "Direct report" }));
  const options = source === "team" ? team : stationPeople ?? [];
  const q = search.trim().toLowerCase();
  const filtered = options.filter((o) => !q || `${o.displayName} ${o.detail}`.toLowerCase().includes(q)).slice(0, 80);
  const chosen = options.find((o) => `${o.workerType}:${o.workerId}` === workerKey);

  async function pickStation(id: string) {
    setStationId(id);
    setWorkerKey("");
    setStationPeople(null);
    if (!id) return;
    setLoadingPeople(true);
    try {
      const r = await fetch(`/api/ops-pulse/salary-hold?station=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "People could not be loaded.");
      setStationPeople((j.people as Array<{ workerType: "employee" | "contractor"; workerId: string; displayName: string; code: string | null; designation: string | null }>).map((p) => ({
        workerType: p.workerType, workerId: p.workerId, displayName: p.displayName, detail: [p.code, p.designation, p.workerType === "contractor" ? "Contractor" : "Employee"].filter(Boolean).join(" · "),
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "People could not be loaded.");
    } finally {
      setLoadingPeople(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return setError("Choose the person.");
    const invalid = validateRaise({ holdType, amount, days, reason });
    if (invalid) return setError(invalid);
    const form = new FormData();
    form.set("workerType", chosen.workerType);
    form.set("workerId", chosen.workerId);
    form.set("holdType", holdType);
    form.set("amount", amount);
    form.set("days", days);
    form.set("reason", reason);
    setError("");
    start(async () => {
      const result = await placeSalaryHold(form);
      if (!result.ok) return setError(result.message);
      setWorkerKey(""); setAmount(""); setDays(""); setReason(""); setSearch("");
      onDone(result.message);
    });
  }

  if (!workspace.designationTierCleared)
    return <section className={styles.card}><h2>Raise a salary hold</h2><p className={styles.hint}>Only Senior Store Manager and above can raise a salary hold.</p></section>;
  return (
    <form className={styles.card} onSubmit={submit}>
      <h2>Raise a salary hold</h2>
      <p className={styles.hint}>For a direct report or anyone working at your stations. The station&apos;s cluster manager approves it before payroll withholds anything.</p>
      <div className={styles.toggle} role="group" aria-label="Who">
        <button type="button" aria-pressed={source === "team"} onClick={() => { setSource("team"); setWorkerKey(""); }} disabled={!team.length}>My team{team.length ? ` · ${team.length}` : ""}</button>
        <button type="button" aria-pressed={source === "station"} onClick={() => { setSource("station"); setWorkerKey(""); }} disabled={!workspace.stations.length}>A station</button>
      </div>
      {source === "station" ? (
        <label>Station
          <select value={stationId} onChange={(e) => void pickStation(e.target.value)} disabled={busy}>
            <option value="">Choose a station…</option>
            {workspace.stations.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
          </select>
        </label>
      ) : null}
      {source === "team" || stationPeople ? (
        <label>Person
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${options.length} people`} disabled={busy} />
          <div className={styles.people} role="listbox" aria-label="People">
            {filtered.map((o) => {
              const key = `${o.workerType}:${o.workerId}`;
              return (
                <button type="button" role="option" aria-selected={workerKey === key} key={key} className={workerKey === key ? styles.personOn : styles.person} onClick={() => setWorkerKey(key)}>
                  <b>{o.displayName}</b><small>{o.detail}</small>
                </button>
              );
            })}
            {!filtered.length ? <small className={styles.hint}>{options.length ? "No one matches." : source === "team" ? "No direct reports on record in People." : "No active People at this station."}</small> : null}
          </div>
        </label>
      ) : loadingPeople ? <p className={styles.hint}>Loading people…</p> : null}
      <div className={styles.toggle} role="group" aria-label="Hold type">
        <button type="button" aria-pressed={holdType === "amount"} onClick={() => setHoldType("amount")}>Amount</button>
        <button type="button" aria-pressed={holdType === "days"} onClick={() => setHoldType("days")}>Days of salary</button>
      </div>
      {holdType === "amount"
        ? <label>Amount to hold (₹)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
        : <label>Days to hold<input type="number" min="0.5" max="31" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} disabled={busy} /><span className={styles.hint}>Converted at that month&apos;s day rate in payroll.</span></label>}
      <label>Reason<textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} placeholder="What happened and why salary should be held" /></label>
      {chosen ? <p className={styles.summary}>Hold <b>{holdType === "amount" ? (amount ? `₹${amount}` : "—") : `${days || "—"} day(s)`}</b> for <b>{chosen.displayName}</b></p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className={styles.primary} disabled={busy || !chosen}>{busy ? "Raising…" : "Send for approval"}</button>
    </form>
  );
}

export function OpsSalaryHold({ initial }: { initial: SalaryHoldWorkspace }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<"approvals" | "mine" | "decided">(initial.approvals.length ? "approvals" : "mine");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function refresh(note = "") {
    setMessage(note);
    setError("");
    try {
      const response = await fetch("/api/ops-pulse/salary-hold", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Salary holds could not be refreshed.");
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Salary holds could not be refreshed.");
    }
  }
  const lists = { approvals: data.approvals, mine: data.holds, decided: data.decided };
  const empty = {
    approvals: "Nothing waits for your decision. Requests from stations where you are the cluster manager appear here.",
    mine: "You have not raised any salary holds.",
    decided: "No decisions in the last 60 days.",
  };
  return (
    <div className={styles.desk}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>TEAM OPS · PEOPLE</span>
          <h1>Salary Hold</h1>
          <p>Raise a hold with a reason; the station&apos;s cluster manager approves it before payroll withholds anything, and approves its release the same way. Every step is recorded.</p>
        </div>
        <div className={styles.flow} aria-label="Workflow">
          <span>Raised</span><i>→</i><span>CM approves</span><i>→</i><span>Withheld</span><i>→</i><span>Release approved</span><i>→</i><span>Paid back</span>
        </div>
      </header>
      {message ? <p className={styles.success} role="status">{message}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.grid}>
        <RaiseForm workspace={data} onDone={(m) => { setTab("mine"); void refresh(m); }} />
        <section className={styles.list}>
          <div className={styles.tabs} role="tablist">
            {([["approvals", "For my approval"], ["mine", "Raised by me"], ["decided", "Decided by me"]] as const).map(([key, label]) => (
              <button key={key} role="tab" className={styles.tab} aria-selected={tab === key} onClick={() => setTab(key)}>
                {label}<span className={styles.count}>{lists[key].length}</span>
              </button>
            ))}
          </div>
          {lists[tab].length ? lists[tab].map((h) => <HoldCard key={h.id} hold={h} onDone={(m) => void refresh(m)} />) : <p className={styles.empty}>{empty[tab]}</p>}
        </section>
      </div>
    </div>
  );
}
