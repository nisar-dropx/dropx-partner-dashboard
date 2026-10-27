"use client";

import { useCallback, useEffect, useState } from "react";
import { RecoveryDetail, type Recovery } from "./connect-loss-recovery-detail";

const money = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { ConnectDialog } from "./connect-dialog";
import styles from "./connect-loss-recoveries.module.css";
const monthLabel = (value: string) => value;

export function ConnectLossRecoveries({
  accountId,
  profileType,
}: {
  accountId: string;
  profileType: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Recovery[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({ accountId, profileType });
      const response = await fetch(`/api/connect/loss-recoveries?${q}`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load loss recoveries.");
      setRows(Array.isArray(body.recoveries) ? body.recoveries : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load loss recoveries.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [accountId, profileType]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitClarification(row: Recovery) {
    if (note.trim().length < 10) {
      setError("Explain the clarification in at least 10 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/connect/loss-recoveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          profileType,
          month: row.month,
          caseKey: row.caseKey,
          note: note.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to submit clarification.");
      setNote("");
      setActive(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit clarification.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;
  if (!rows.length && !error) return null;

  return (
    <section className={styles.summary} aria-label="Loss recoveries on your pay">
      <button type="button" className={styles.trigger} onClick={()=>setOpen(true)} aria-haspopup="dialog"><span>Loss recovery <small>{error ? "Unable to load · tap to retry" : `${rows.length} shipment${rows.length===1?"":"s"} · outstanding`}</small></span><strong>{error ? "—" : money(rows.reduce((sum,r)=>sum+r.outstanding,0))} <span aria-hidden>›</span></strong></button>
      {open ? <ConnectDialog title="Loss recovery" eyebrow="Your assigned shipments" onClose={()=>setOpen(false)} className={styles.dialog}>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      <ul className={styles.list}>
        {rows.map((row) => {
          const key = `${row.month}:${row.caseKey}`;
          return (
            <li key={key}>
              <strong>
                {row.reason} · Shipment ID {row.tid || row.caseKey}
              </strong>
              <small>
                {monthLabel(row.month)} · {row.stationCode} ·{" "}
                {row.recoveryMode === "installments"
                  ? `Instalments (${row.installmentCount || "—"})`
                  : "Full recovery"}{" "}
                · Status {row.status.replaceAll("_", " ")}
              </small>
              <p>
                Your share {money(row.myShareAmount)} · Deducted {money(row.deducted)} · Outstanding{" "}
                {money(row.outstanding)}
                {row.inPayroll > 0 ? ` · In draft payroll ${money(row.inPayroll)}` : ""}
              </p>
              {row.clarifications?.length ? <details><summary>Questions &amp; replies · {row.clarifications.length}</summary>{row.clarifications.map((q,i)=><div key={i}><p><b>You:</b> {q.note}</p>{q.decision_note?<p><b>{q.decided_by_name||"Loss review team"}:</b> {q.decision_note}</p>:<small>Awaiting loss review team · recovery paused</small>}</div>)}</details>:null}
              <div className={styles.actions}>
                <button type="button" onClick={() => setDetail(row)}>
                  View details
                </button>
                {active === key ? (
                  <div>
                    <label>
                      Ask the loss review team
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        maxLength={4000}
                      />
                    </label>
                    <small>Reviewed by SLP / Finance / National Head / Managing Partner. Your recovery pauses for review; the reply appears here.</small>
                    <button type="button" disabled={busy} onClick={() => void submitClarification(row)}>
                      Send for review
                    </button>
                    <button type="button" disabled={busy} onClick={() => setActive(null)}>
                      Cancel
                    </button>
                  </div>
                ) : row.approvalStatus === "approved" ? (
                  <button type="button" onClick={() => setActive(key)}>
                    Request clarification
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      </ConnectDialog> : null}
      {detail ? <RecoveryDetail detail={detail} onClose={() => setDetail(null)}/> : null}
    </section>
  );
}
