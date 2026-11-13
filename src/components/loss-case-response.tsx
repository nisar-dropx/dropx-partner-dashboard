"use client";
import { useEffect, useId, useState } from "react";
import { TrackingDetailModal } from "./tracking-detail-modal";
import { ImproveRedisputeRemark } from "./improve-redispute-remark";
import { LossPidTimeline } from "./loss-pid-timeline";
import { LossEvidencePreview } from "./loss-evidence-preview";
import type { RedisputeWindow } from "./loss-redispute-desk";
import styles from "./nl-loss.module.css";
import { responseActions } from "@/lib/ops-pulse/loss-response-actions";
import { stationEvidenceError, type StationEvidence } from "@/lib/ops-pulse/loss-station-evidence";
import evidenceStyles from "./loss-case-response.module.css";
type Data = {
  window: {
    version: number;
    enabled: boolean;
    workflow_status?: string;
    tt_reference?: string;
    tt_url?: string;
    recovery_month?: string;
    response_details?: Partial<StationEvidence>;
  };
  events: {
    id: string;
    action: string;
    note: string;
    evidence_url?: string;
    actor_name: string;
    created_at: string;
    tracking?: { details?: Partial<StationEvidence> };
  }[];
  canActivate: boolean;
  readOnly: boolean;
  row: {
    station_code: string;
    amount: number;
    source_status: string;
    details: { tid?: string; extra?: Record<string, string> };
  };
};
const labels: Record<string, string> = {
  awaiting_station: "Station evidence needed",
  awaiting_review: "Awaiting review",
  returned: "Returned for correction",
  approved: "Approved · LSC ticket to file",
  with_vendor: "Pending with Amazon",
  won: "Non-recoverable · recovery stopped",
  lost: "Recoverable · recovery resumed",
  cancelled: "Cancelled",
  legacy: "Earlier follow-up",
};
export function LossCaseResponse({
  month,
  caseKey,
  embedded = false,
  inline = false,
  allowTicketEntry = true,
  initialView = "case",
  viewRequest = 0,
  initialAction = "",
  onSaved,
}: {
  month: string;
  caseKey: string;
  embedded?: boolean;
  inline?: boolean;
  allowTicketEntry?: boolean;
  initialView?: "case" | "history";
  viewRequest?: number;
  initialAction?: "" | "return";
  onSaved?: (window: RedisputeWindow) => void;
}) {
  const [view, setView] = useState<"case" | "history">(initialView);
  useEffect(()=>setView(initialView),[initialView,viewRequest]);
  const paneId = useId();
  const istNow = new Date(Date.now() + 330 * 60_000);
  const payrollMonth = (offset: number) => new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
  const nextPayrollMonth = payrollMonth(1), lastPayrollMonth = payrollMonth(12);
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [tracking, setTracking] = useState(false);
  const [action, setAction] = useState<string>(initialAction),
    [note, setNote] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [cctv, setCctv] = useState(""),
    [cctvNotRequired, setCctvNotRequired] = useState(false),
    [ticket, setTicket] = useState(""),
    [ticketUrl, setTicketUrl] = useState(""),
    [due, setDue] = useState(""),
    [payMonth, setPayMonth] = useState("");
  useEffect(()=>setAction(initialAction),[initialAction]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `/api/ops-pulse/losses/case-response?${new URLSearchParams({ month, case: caseKey })}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        return j;
      })
      .then((j) => {
        if(controller.signal.aborted)return;
        setData(j);
        setReason(j.window.response_details?.reason || "");
        setEvidence(j.window.response_details?.evidence_url || "");
        setCctv(j.window.response_details?.cctv_url || "");
        setCctvNotRequired(j.window.response_details?.cctv_not_required === true);
        setNote(embedded || !j.canActivate ? j.window.response_details?.note || "" : "");
        setTicket((embedded || !j.canActivate ? j.window.response_details?.tt_reference : ["with_vendor","won","lost"].includes(j.window.workflow_status||"") ? j.window.tt_reference : "") || "");
        setTicketUrl(j.window.tt_url || "");
        setDue(j.window.followup_on || "");
        setPayMonth(j.window.recovery_month || nextPayrollMonth);

      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [month, caseKey, revision, embedded, nextPayrollMonth]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!data || !selectedAction) return;
    if (!canSubmit) { setError(selectedAction === "response" ? evidenceError || "Complete all required fields." : "Add a clear update (10–4000 characters)."); return; }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const r = await fetch("/api/ops-pulse/losses/case-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          case_key: caseKey,
          version: data.window.version,
          action: selectedAction,
          note,
          reason,
          evidence_url: evidence,
          cctv_url: cctvNotRequired ? "" : cctv,
          cctv_not_required: cctvNotRequired,
          tt_reference: ticket,
          tt_url: ticketUrl,
          followup_on: due,
          recovery_month: payMonth,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setSuccess(j.payroll_sync?.message || "Redispute update saved.");
      setNote("");
      onSaved?.(j.window);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  const state = data?.window.workflow_status || "legacy";
  // Context matters even for managers: the station editor is evidence-only.
  const stationView = embedded || !data?.canActivate;
  const actions = responseActions({enabled: !!data?.window.enabled, state,
    canManage: !!data?.canActivate, stationView, readOnly: !data || data.readOnly})
    .filter(value=>allowTicketEntry||!["tracking","won","lost"].includes(value));
  const selectedAction = actions.includes(action) ? action : actions[0] || "";
  const evidenceError = stationEvidenceError({ reason, note, tt_reference: ticket,
    evidence_url: evidence, cctv_url: cctv, cctv_not_required: cctvNotRequired });
  const validNote = note.trim().length >= 10 && note.trim().length <= 4000;
  const canSubmit = selectedAction === "response" ? !evidenceError : !!selectedAction && validNote
    && (!["tracking", "won", "lost"].includes(selectedAction) || (ticket.trim().length >= 3 && ticket.trim().length <= 160 && (!ticketUrl || (ticketUrl.startsWith("https://") && ticketUrl.length <= 2000))))
    && (selectedAction !== "tracking" || !!due)
    && (selectedAction !== "lost" || (/^\d{4}-(0[1-9]|1[0-2])$/.test(payMonth) && payMonth >= nextPayrollMonth && payMonth <= lastPayrollMonth));
  const returnEvent = state === "returned" ? data?.events.find((event) => event.action === "return") : null;
  const actionNames: Record<string, string> = {
    activate: "Activate redispute",
    response: state === "returned" ? "Resubmit station evidence" : "Submit station evidence",
    approve: "Approve response",
    return: "Return for correction",
    tracking: "Record / update LSC ticket",
    won: "Final outcome · non-recoverable",
    lost: "Final outcome · recoverable",
    revoke: "Remove redispute",
  };
  return (
    <section
      className={`${styles.workspace} ${evidenceStyles.console}`}
      style={{ maxWidth: inline ? "none" : 1000, margin: "0 auto", ...(embedded || inline ? {padding:0} : {}) }}
    >
      {!embedded && !inline ? <a href={data?.canActivate ? "/team-ops/losses/exceptions?view=redisputes" : `/team-ops/losses/recovery-updates?${new URLSearchParams({month,case:caseKey})}`}>← {data?.canActivate ? "Redispute tracking" : "Recovery"}</a> : null}
      {!inline && (embedded ? <h3>Shipment redispute</h3> : <h1>Shipment redispute</h1>)}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {success ? <p role="status" className={styles.done}>{success}</p> : null}
      {!data ? (
        <p role="status">Loading shipment…</p>
      ) : (
        <>
          <section className={evidenceStyles.frame}>
            {!inline ? <div className={evidenceStyles.dash}>
              <button
                className={styles.button}
                onClick={() => setTracking(true)}
              >
                {data.row.station_code} · {data.row.details.tid || caseKey} ↗
              </button>
              <strong>
                ₹{Number(data.row.amount).toLocaleString("en-IN")}
              </strong>
              <span className={evidenceStyles.signal} data-state={state}>
                {data.window.enabled
                  ? labels[state] || state
                  : data.window.workflow_status
                    ? labels[state]
                    : "Not activated"}
              </span>
            </div>:null}
            <TrackingDetailModal
              trackingId={tracking ? data.row.details.tid || null : null}
              stationHint={data.row.station_code}
              onClose={() => setTracking(false)}
            />
            <div className={evidenceStyles.selector} role="group" aria-label="Redispute view">
              <button type="button" aria-pressed={view === "case"} aria-controls={paneId + "-case"} onClick={() => setView("case")}>Evidence &amp; status</button>
              <button type="button" aria-pressed={view === "history"} aria-controls={paneId + "-history"} onClick={() => setView("history")}>History · {data.events.length}</button>
              {inline?<button type="button" onClick={()=>setTracking(true)}>Shipment tracking</button>:null}
            </div>
            <div hidden={view !== "case"} id={paneId + "-case"}>
            {!allowTicketEntry&&state==='approved'?<p className={styles.hint}>Approved. <a href="/team-ops/losses/exceptions?view=lsc">Open LSC follow-up</a> to download or record a ticket later.</p>:null}
            {returnEvent ? <div className={evidenceStyles.returnNote} role="status">
              <strong>Returned for correction</strong>
              <p>{returnEvent.note}</p>
              <small>{returnEvent.actor_name} · {new Date(returnEvent.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small>
            </div> : null}
            {data.window.response_details?.reason ? (
              <details className={`${styles.compactDetails} ${evidenceStyles.context}`} open>
                <summary>Station submission</summary>
                <strong>{data.window.response_details.reason}</strong>
                <p>{data.window.response_details.note}</p>
                <EvidenceLinks details={data.window.response_details} />
              </details>
            ) : null}
            {data.window.recovery_month ? (
              <p className={styles.hint}>
                Recovery resumes from {data.window.recovery_month}. Earlier
                deductions remain unchanged.
              </p>
            ) : null}
            <details className={`${styles.compactDetails} ${evidenceStyles.context}`}>
              <summary>Earlier vendor context</summary>
              <p>
                {data.row.details.extra?.nl_remarks ||
                  data.row.details.extra?.nl_res ||
                  data.row.source_status}
              </p>
              <p>{data.row.details.extra?.partner_remarks}</p>
            </details>
          {!data.readOnly &&
          actions.length > 0 &&
          (data.canActivate || data.window.enabled) ? (
            <section>
              <form onSubmit={save} className={evidenceStyles.editor}>
                <div className={evidenceStyles.grid}>
                  {actions.length > 1 ? <label>
                    Next action
                    <select value={selectedAction} onChange={(e) => setAction(e.target.value)}>
                      {actions.map((a) => <option key={a} value={a}>{actionNames[a]}</option>)}
                    </select>
                  </label> : null}
                  {selectedAction === "response" ? (
                    <>
                      <label>
                        Redispute reason *
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          minLength={5}
                          maxLength={300}
                          required
                        />
                      </label>
                      <label>
                        Cloak ticket ID *
                        <input
                          value={ticket}
                          onChange={(e) => setTicket(e.target.value)}
                          minLength={3}
                          maxLength={160}
                          required
                        />
                      </label>
                      <label>
                        Supporting photos / files link *
                        <input
                          type="url"
                          value={evidence}
                          onChange={(e) => setEvidence(e.target.value)}
                          required
                          maxLength={2000}
                          placeholder="https://drive.google.com/…"
                        />
                      </label>
                      <div className={evidenceStyles.cctv}>
                        <label>
                          CCTV footage / folder link{cctvNotRequired ? "" : " *"}
                          <input type="url" value={cctv} onChange={(e) => setCctv(e.target.value)}
                            required={!cctvNotRequired} disabled={cctvNotRequired} maxLength={2000}
                            placeholder="https://drive.google.com/…" />
                        </label>
                        <label className={evidenceStyles.checkbox}>
                          <input type="checkbox" checked={cctvNotRequired}
                            onChange={(e) => setCctvNotRequired(e.target.checked)} />
                          CCTV footage not required
                        </label>
                      </div>
                      <details className={evidenceStyles.help}>
                        <summary>ⓘ Sharing files</summary>
                        <span>Upload photos/videos to Google Drive. For multiple files, share one folder. Set Share → General access → Anyone with the link → Viewer, then paste the link. The same folder can cover both fields.</span>
                      </details>
                    </>
                  ) : null}
                  {["tracking", "won", "lost"].includes(selectedAction) ? (
                    <>
                      <label>
                        LSC ticket ID *
                        <input
                          value={ticket}
                          readOnly={selectedAction !== "tracking"}
                          onChange={(e) => setTicket(e.target.value)}
                          minLength={3}
                          maxLength={160}
                          required
                        />
                      </label>
                      <label>
                        Ticket link
                        <input
                          type="url"
                          value={ticketUrl}
                          readOnly={selectedAction !== "tracking"}
                          maxLength={2000}
                          onChange={(e) => setTicketUrl(e.target.value)}
                        />
                      </label>
                      {selectedAction === "tracking" ? (
                        <label>
                          Next follow-up
                          <input
                            type="date"
                            value={due}
                            onChange={(e) => setDue(e.target.value)}
                            required
                          />
                        </label>
                      ) : null}
                      {selectedAction === "lost" ? (
                        <label>
                          Recovery payroll month
                          <input
                            type="month"
                            value={payMonth}
                            min={nextPayrollMonth}
                            max={lastPayrollMonth}
                            required
                            onChange={(e) => setPayMonth(e.target.value)}
                          />
                          <small>
                            Recovery resumes in the selected upcoming payroll.
                          </small>
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <label className={evidenceStyles.remark}>
                    {selectedAction === "response"
                      ? "Detailed description *"
                      : selectedAction === "return" ? "Correction note to station *" : "Decision / update"}
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      minLength={10}
                      maxLength={4000}
                      required
                      placeholder={selectedAction === "response" ? "Explain why the loss should be reconsidered and what the evidence shows." : selectedAction === "return" ? "Tell the station exactly what to correct before resubmitting." : undefined}
                    />
                  </label>
                {selectedAction === "response" && (
                  <ImproveRedisputeRemark key={JSON.stringify([month, caseKey, data.window.version])}
                    month={month} caseKey={caseKey} note={note} onUse={setNote} disabled={busy} />
                )}
                <div className={styles.toolbar}>
                  <button className={styles.primary} disabled={busy || !canSubmit}>
                    {busy ? "Saving…" : actionNames[selectedAction]}
                  </button>
                  <small>
                    {selectedAction === "return" ? "The station will see this note and can correct and resubmit." : selectedAction === "response" && !canSubmit ? "Complete all required fields to submit." : "Recorded in OpsPulse; tickets are filed with the vendor separately."}
                  </small>
                </div>
              </form>
            </section>
          ) : null}
            </div>
            <div hidden={view !== "history"} className={evidenceStyles.history} id={paneId + "-history"}>
            {view === "history" ? <LossPidTimeline month={month} caseKey={caseKey} revision={revision}/>:null}
            {data.events.length === 0 && <small>No redispute updates yet.</small>}
            {data.events.map((e) => (
              <article className={styles.allocation} key={e.id}>
                <strong>{actionNames[e.action] || e.action}</strong>
                <small>
                  {" "}
                  · {e.actor_name} ·{" "}
                  {new Date(e.created_at).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}
                </small>
                {e.action === "response" && e.tracking?.details?.reason ? <strong>{e.tracking.details.reason}</strong> : null}
                <p>{e.note}</p>
                {e.action === "response" && e.tracking?.details ? <EvidenceLinks details={e.tracking.details} /> : e.evidence_url ? (
                  <LossEvidencePreview href={e.evidence_url} label="Evidence" className={styles.button}/>
                ) : null}
              </article>
            ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function EvidenceLinks({ details }: { details: Partial<StationEvidence> }) {
  return <div className={evidenceStyles.links}>
    {details.tt_reference ? <span>Cloak ticket: {details.tt_reference}</span> : null}
    {details.evidence_url ? <LossEvidencePreview href={details.evidence_url} label="Supporting files" className={styles.button}/> : null}
    {details.cctv_not_required === true ? <span>CCTV not required</span> : details.cctv_url ?
      <LossEvidencePreview href={details.cctv_url} label="CCTV footage" className={styles.button}/> : null}
  </div>;
}
