"use client";
import { useEffect, useRef, useState } from "react";
import { TrackingDetailModal } from "./tracking-detail-modal";
import { LossPidTimeline } from "./loss-pid-timeline";
import styles from "./nl-loss.module.css";
import { redisputeStatus, ticketStatuses, ticketUpdateError } from "@/lib/ops-pulse/loss-redispute-queue";
import type { RedisputeWindow } from "./loss-redispute-desk";
import { responseActions } from "@/lib/ops-pulse/loss-response-actions";
import { stationEvidenceError, type StationEvidence } from "@/lib/ops-pulse/loss-station-evidence";
import evidenceStyles from "./loss-case-response.module.css";
type Data = {
  window: RedisputeWindow;
  events: {
    id: string;
    action: string;
    note: string;
    evidence_url?: string;
    actor_name: string;
    created_at: string;
    tracking?: { details?: Partial<StationEvidence> & { followup_status?: string; tt_url?: string; followup_on?: string }; after?: RedisputeWindow };
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
export function LossCaseResponse({
  month,
  caseKey,
  embedded = false,
  initialAction = "",
  inlineManager = false,
  onSaved,
}: {
  month: string;
  caseKey: string;
  embedded?: boolean;
  initialAction?: "" | "return";
  inlineManager?: boolean;
  onSaved?: (window: RedisputeWindow) => void;
}) {
  const saving = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState("");
  const [ticketStatus, setTicketStatus] = useState("filed");
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
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
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
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
        setTicket((embedded || !j.canActivate ? j.window.response_details?.tt_reference : (j.window.workflow_status === "approved" ? "" : j.window.tt_reference)) || "");
        setTicketUrl(j.window.tt_url || "");
        setDue(j.window.followup_on || "");
        setTicketStatus(j.window.workflow_status === "approved" || j.window.followup_status === "filed" ? "filed" : "with_vendor");

      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, caseKey, revision, embedded]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!data || !selectedAction || saving.current) return;
    if (!canSubmit) { setError(selectedAction === "response" ? evidenceError || "Complete all required fields." : ticketError || "Add a clear update (10–4000 characters)."); return; }
    saving.current = true;
    setBusy(true);
    setSaved("");
    setError("");
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
          followup_status: ticketStatus,
          recovery_month: payMonth,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setData(current => current ? { ...current, window: j.window } : current);
      if (selectedAction === "approve") { setTicket(""); setTicketUrl(""); setDue(""); setTicketStatus("filed"); }
      onSaved?.(j.window);
      setSaved("Update saved.");
      setAction("");
      setNote("");
      setLoading(true);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const state = data?.window.workflow_status || "legacy";
  // Context matters even for managers: the station editor is evidence-only.
  const stationView = embedded || !data?.canActivate;
  const actions = responseActions({enabled: !!data?.window.enabled, state,
    canManage: !!data?.canActivate, stationView, readOnly: !data || data.readOnly});
  const selectedAction = actions.includes(action) ? action : actions[0] || "";
  const evidenceError = stationEvidenceError({ reason, note, tt_reference: ticket,
    evidence_url: evidence, cctv_url: cctv, cctv_not_required: cctvNotRequired });
  const validNote = note.trim().length >= 10 && note.trim().length <= 4000;
  const ticketError = ticketUpdateError(selectedAction, { tt_reference: ticket, tt_url: ticketUrl, followup_on: due, followup_status: ticketStatus });
  const canSubmit = !loading && (selectedAction === "response" ? !evidenceError : !!selectedAction && validNote && !ticketError);
  const returnEvent = state === "returned" ? data?.events.find((event) => event.action === "return") : null;
  const actionNames: Record<string, string> = {
    activate: "Activate redispute",
    response: state === "returned" ? "Resubmit station evidence" : "Submit station evidence",
    approve: "Confirm station evidence",
    return: "Return for correction",
    tracking: state === "approved" ? "Record ticket raised" : "Update ticket / follow-up",
    won: "Recovered · redispute successful",
    lost: "Unsuccessful · resume recovery",
    revoke: "Remove redispute",
  };
  return (
    <section
      className={styles.workspace}
      style={{ maxWidth: 1000, margin: "0 auto", ...(embedded ? {padding:0} : {}) }}
    >
      {!embedded && !inlineManager ? <a href={data?.canActivate ? "/team-ops/losses/exceptions?view=redisputes" : `/team-ops/losses/recovery-updates?${new URLSearchParams({month,case:caseKey})}`}>← {data?.canActivate ? "Redispute tracking" : "Recovery"}</a> : null}
      {embedded ? <h3>Redispute evidence &amp; status</h3> : !inlineManager ? <h1>Shipment redispute</h1> : null}
      {!inlineManager ? <LossPidTimeline month={month} caseKey={caseKey} revision={revision}/> : null}
      {saved ? <p role="status">{saved}</p> : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error} <button type="button" className={styles.button} disabled={busy || loading} onClick={() => setRevision(n => n + 1)}>Reload latest status</button>
        </p>
      ) : null}
      {!data ? (
        <p role="status">{error ? "Shipment could not be loaded." : "Loading shipment…"}</p>
      ) : (
        <>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <button
                className={styles.button}
                onClick={() => setTracking(true)}
              >
                {data.row.station_code} · {data.row.details.tid || caseKey} ↗
              </button>
              <strong>
                ₹{Number(data.row.amount).toLocaleString("en-IN")}
              </strong>
              <span>
                {redisputeStatus(data.window)}
              </span>
            </div>
            <TrackingDetailModal
              trackingId={tracking ? data.row.details.tid || null : null}
              stationHint={data.row.station_code}
              onClose={() => setTracking(false)}
            />
            {!stationView ? <ol className={evidenceStyles.lifecycle} aria-label="Redispute lifecycle">
              {['Station evidence', 'SLP confirmation', 'Ticket raised', 'Amazon follow-up', 'Outcome'].map((label, index) => {
                const step = ['won', 'lost'].includes(state) ? 4 : state === 'with_vendor' ? (data.window.followup_status === 'filed' ? 2 : 3) : state === 'approved' ? 2 : state === 'awaiting_review' ? 1 : 0;
                return <li key={label} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>{label}</li>;
              })}
            </ol> : null}
            {!stationView && state === 'approved' ? <p className={styles.hint}>Station evidence confirmed. Raise the Amazon ticket, then record its ID and next follow-up here.</p> : null}
            {!stationView && data.window.tt_reference && state !== 'approved' && ['with_vendor', 'won', 'lost'].includes(state) ? <div className={evidenceStyles.links}>
              <strong>Amazon ticket: {data.window.tt_url ? <a href={data.window.tt_url} target="_blank" rel="noreferrer">{data.window.tt_reference} ↗</a> : data.window.tt_reference}</strong>
              {data.window.enabled && data.window.followup_on ? <span>Next follow-up: {data.window.followup_on}</span> : null}
            </div> : null}
            {returnEvent ? <div className={evidenceStyles.returnNote} role="status">
              <strong>Returned for correction</strong>
              <p>{returnEvent.note}</p>
              <small>{returnEvent.actor_name} · {new Date(returnEvent.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small>
            </div> : null}
            {data.window.response_details?.reason ? (
              <details className={styles.compactDetails} open>
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
            <details className={styles.compactDetails}>
              <summary>Earlier vendor context</summary>
              <p>
                {data.row.details.extra?.nl_remarks ||
                  data.row.details.extra?.nl_res ||
                  data.row.source_status}
              </p>
              <p>{data.row.details.extra?.partner_remarks}</p>
            </details>
          </section>
          {!data.readOnly &&
          actions.length > 0 &&
          (data.canActivate || data.window.enabled) ? (
            <section className={styles.panel}>
              <form onSubmit={save} className={styles.detail}>
                <fieldset disabled={busy || loading} className={evidenceStyles.fields}>
                <div className={styles.formGrid}>
                  {actions.includes('tracking') ? <label>
                    Status
                    <select aria-label="Status" value={selectedAction === 'tracking' ? ticketStatus : selectedAction} onChange={e => {
                      const value = e.target.value;
                      if (value === 'filed' || value === 'with_vendor') { setAction('tracking'); setTicketStatus(value); }
                      else setAction(value);
                    }}>
                      {ticketStatuses.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
                      {actions.filter(a => a !== 'tracking').map(a => <option key={a} value={a}>{actionNames[a]}</option>)}
                    </select>
                  </label> : actions.length > 1 ? <label>
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
                        Amazon ticket ID *
                        <input
                          value={ticket}
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
                          onChange={(e) => setTicketUrl(e.target.value)}
                          maxLength={2000}
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
                            onChange={(e) => setPayMonth(e.target.value)}
                          />
                          <small>
                            Defaults to next month; the payroll cutoff still
                            applies.
                          </small>
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <label>
                    {selectedAction === "response"
                      ? "Detailed description *"
                      : selectedAction === "return" ? "Correction note to station *" : "Remarks *"}
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
                {selectedAction === 'won' ? <p className={styles.hint}>Confirm Amazon accepted the redispute. This stops the remaining payroll recovery; previous deductions are unchanged.</p> : null}
                {ticketError ? <small className={styles.hint}>{ticketError}</small> : null}
                <div className={styles.toolbar}>
                  <button className={styles.primary} disabled={busy || !canSubmit}>
                    {busy ? "Saving…" : actionNames[selectedAction]}
                  </button>
                  <small>
                    {selectedAction === "return" ? "The station will see this note and can correct and resubmit." : selectedAction === "response" && !canSubmit ? "Complete all required fields to submit." : "Recorded in OpsPulse; tickets are filed with the vendor separately."}
                  </small>
                </div>
                </fieldset>
              </form>
            </section>
          ) : null}
          <details className={styles.compactDetails}>
            <summary>History · {data.events.length}</summary>
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
                {['tracking', 'won', 'lost'].includes(e.action) && e.tracking?.after ? <div className={evidenceStyles.links}>
                  <span>{redisputeStatus(e.tracking.after)}</span>
                  <span>Ticket: {e.tracking.after.tt_reference}</span>
                  {e.tracking.after.followup_on ? <span>Follow-up: {e.tracking.after.followup_on}</span> : null}
                </div> : null}
                {e.action === "response" && e.tracking?.details ? <EvidenceLinks details={e.tracking.details} /> : e.evidence_url ? (
                  <a href={e.evidence_url} target="_blank" rel="noreferrer">
                    Evidence ↗
                  </a>
                ) : null}
              </article>
            ))}
          </details>
        </>
      )}
    </section>
  );
}

function EvidenceLinks({ details }: { details: Partial<StationEvidence> }) {
  return <div className={evidenceStyles.links}>
    {details.tt_reference ? <span>Cloak ticket: {details.tt_reference}</span> : null}
    {details.evidence_url ? <a href={details.evidence_url} target="_blank" rel="noreferrer">Supporting files ↗</a> : null}
    {details.cctv_not_required === true ? <span>CCTV not required</span> : details.cctv_url ?
      <a href={details.cctv_url} target="_blank" rel="noreferrer">CCTV footage ↗</a> : null}
  </div>;
}
