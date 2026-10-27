"use client";
import { useEffect, useState } from "react";
import { TrackingDetailModal } from "./tracking-detail-modal";
import styles from "./nl-loss.module.css";
type Data = {
  window: {
    version: number;
    enabled: boolean;
    workflow_status?: string;
    tt_reference?: string;
    tt_url?: string;
    recovery_month?: string;
    response_details?: Record<string, string>;
  };
  events: {
    id: string;
    action: string;
    note: string;
    evidence_url?: string;
    actor_name: string;
    created_at: string;
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
  approved: "Approved · file post-dispute ticket",
  with_vendor: "With vendor",
  won: "Won · recovery stopped",
  lost: "Unsuccessful · recovery resumed",
  cancelled: "Cancelled",
  legacy: "Earlier follow-up",
};
export function LossCaseResponse({
  month,
  caseKey,
}: {
  month: string;
  caseKey: string;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [tracking, setTracking] = useState(false);
  const [action, setAction] = useState("activate"),
    [note, setNote] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [ticket, setTicket] = useState(""),
    [ticketUrl, setTicketUrl] = useState(""),
    [due, setDue] = useState(""),
    [payMonth, setPayMonth] = useState("");
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
        setData(j);
        setTicket(j.window.tt_reference || "");
        setTicketUrl(j.window.tt_url || "");
        const state = j.window.workflow_status;
        setAction(
          !j.window.enabled
            ? "activate"
            : state === "awaiting_review" && j.canActivate
              ? "approve"
              : ["approved", "with_vendor"].includes(state)
                ? "tracking"
                : "response",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [month, caseKey, revision]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/ops-pulse/losses/case-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          case_key: caseKey,
          version: data.window.version,
          action,
          note,
          reason,
          evidence_url: evidence,
          tt_reference: ticket,
          tt_url: ticketUrl,
          followup_on: due,
          recovery_month: payMonth,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setNote("");
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  const state = data?.window.workflow_status || "legacy",
    review = state === "awaiting_review",
    follow = ["approved", "with_vendor"].includes(state),
    canRespond = ["awaiting_station", "returned", "legacy"].includes(state);
  const actions = !data?.window.enabled
    ? ["activate"]
    : data.canActivate
      ? [
          ...(review ? ["approve", "return"] : []),
          ...(follow ? ["tracking", "won", "lost"] : []),
          ...(canRespond ? ["response"] : []),
          "revoke",
        ]
      : canRespond
        ? ["response"]
        : [];
  const actionNames: Record<string, string> = {
    activate: "Activate redispute",
    response: "Submit station evidence",
    approve: "Approve response",
    return: "Return for correction",
    tracking: "Update post-dispute ticket",
    won: "Final outcome · won",
    lost: "Final outcome · unsuccessful",
    revoke: "Cancel redispute",
  };
  return (
    <main
      className={styles.workspace}
      style={{ maxWidth: 1000, margin: "0 auto" }}
    >
      <a href="/team-ops/losses/redisputes">← Redisputes</a>
      <h1>Shipment redispute</h1>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {!data ? (
        <p role="status">Loading shipment…</p>
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
                {data.window.enabled
                  ? labels[state] || state
                  : data.window.workflow_status
                    ? labels[state]
                    : "Not activated"}
              </span>
            </div>
            <TrackingDetailModal
              trackingId={tracking ? data.row.details.tid || null : null}
              stationHint={data.row.station_code}
              onClose={() => setTracking(false)}
            />
            {data.window.response_details?.reason ? (
              <details className={styles.compactDetails} open>
                <summary>Station submission</summary>
                <strong>{data.window.response_details.reason}</strong>
                <p>{data.window.response_details.note}</p>
                <span>
                  Ticket {data.window.response_details.tt_reference} ·{" "}
                </span>
                <a
                  href={data.window.response_details.evidence_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Footage / evidence ↗
                </a>
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
                <div className={styles.formGrid}>
                  <label>
                    Next action
                    <select
                      value={action}
                      onChange={(e) => setAction(e.target.value)}
                    >
                      {actions.map((a) => (
                        <option key={a} value={a}>
                          {actionNames[a]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {action === "response" ? (
                    <>
                      <label>
                        Reason
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          minLength={5}
                          maxLength={300}
                          required
                        />
                      </label>
                      <label>
                        Ticket reference
                        <input
                          value={ticket}
                          onChange={(e) => setTicket(e.target.value)}
                          minLength={3}
                          maxLength={160}
                          required
                        />
                      </label>
                      <label>
                        Footage / CCTV evidence link
                        <input
                          type="url"
                          value={evidence}
                          onChange={(e) => setEvidence(e.target.value)}
                          required
                          placeholder="https://…"
                        />
                      </label>
                    </>
                  ) : null}
                  {["tracking", "won", "lost"].includes(action) ? (
                    <>
                      <label>
                        Post-dispute ticket
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
                        />
                      </label>
                      {action === "tracking" ? (
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
                      {action === "lost" ? (
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
                {action === "activate" ? (
                  <p className={styles.hint}>
                    Enable this exceptional shipment. The station then supplies
                    its reason, ticket and evidence for review.
                  </p>
                ) : (
                  <label>
                    {action === "response"
                      ? "Supporting details"
                      : "Decision / update"}
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      minLength={10}
                      maxLength={4000}
                      required
                    />
                  </label>
                )}
                <div className={styles.toolbar}>
                  <button className={styles.primary} disabled={busy}>
                    {busy ? "Saving…" : actionNames[action]}
                  </button>
                  <small>
                    Recorded in OpsPulse; tickets are filed with the vendor
                    separately.
                  </small>
                </div>
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
                <p>{e.note}</p>
                {e.evidence_url ? (
                  <a href={e.evidence_url} target="_blank" rel="noreferrer">
                    Evidence ↗
                  </a>
                ) : null}
              </article>
            ))}
          </details>
        </>
      )}
    </main>
  );
}
