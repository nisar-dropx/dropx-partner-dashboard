"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {paymentRead,latestPaymentRead} from '@/lib/payment-read';
import { RecoveryDetail, monthLabel, type Recovery } from "./connect-loss-recovery-detail";

const money = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { ConnectDialog } from "./connect-dialog";
import styles from "./connect-loss-recoveries.module.css";


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
  const [detail, setDetail] = useState<Recovery | null>(null);
  const paymentRequest=useRef(latestPaymentRead());

  const load = useCallback(async () => {
    const request=paymentRequest.current.start();
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({ accountId, profileType });
      const body = await paymentRead(`/api/connect/loss-recoveries?${q}`, {signal:request.signal});
      if (!Array.isArray(body.recoveries)) throw new Error('Unable to verify loss recoveries. Please retry.');
      if(request.isCurrent())setRows(body.recoveries);
    } catch (e) {
      if(!request.isCurrent())return;
      setError(e instanceof Error ? e.message : "Unable to load loss recoveries.");
      setRows([]);
    } finally {
      if(request.isCurrent())setLoading(false);
    }
  }, [accountId, profileType]);

  useEffect(() => {
    setRows([]);setOpen(false);setDetail(null);
    void load();
    return ()=>paymentRequest.current.cancel();
  }, [load]);

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
                Loss {monthLabel(row.month)} · {row.stationCode} ·{" "}
                {row.recoveryMode === "installments"
                  ? `Instalments (${row.installmentCount || "—"})`
                  : "Full recovery"}{" "}
                · Status {row.status.replaceAll("_", " ")}
              </small>
              <small><strong>Salary: {row.scheduledFromMonth ? monthLabel(row.scheduledFromMonth) : 'Not recorded'}</strong> · planned start</small>
              <p>
                Your share {money(row.myShareAmount)} · Deducted {money(row.deducted)} · Outstanding{" "}
                {money(row.outstanding)}
                {row.inPayroll > 0 ? ` · In draft payroll ${money(row.inPayroll)}` : ""}
              </p>
              <div className={styles.actions}>
                <button type="button" onClick={() => setDetail(row)}>
                  View details
                </button>
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
