"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LossPeriodClosure } from "@/lib/ops-pulse/loss-period-close";
import styles from "./nl-loss.module.css";
export function LossPeriodClose({report,period,label,stations,closures,canClose}: {
  report: "nl"|"slp"; period: string|null; label: string; stations: string[];
  closures: LossPeriodClosure[]; canClose: boolean;
}) {
  const router=useRouter();
  const [confirm,setConfirm]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const matching=closures.filter(c=>(!period || c.period===period)&&stations.includes(c.station_code));
  const open=stations.filter(s=>!matching.some(c=>c.station_code===s));
  async function submit() {
    setBusy(true);setError("");
    try {
      const r=await fetch("/api/ops-pulse/losses/period-close",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({report,period,stations:open})});
      const data=await r.json();if(!r.ok) throw Error(data.error||"Final submission failed.");
      setConfirm(false);router.refresh();
    } catch(e) {setError(e instanceof Error?e.message:"Final submission failed.");}
    finally {setBusy(false);}
  }
  if(!canClose&&!matching.length) return null;
  return <section className={styles.panel} aria-label="Final loss submission" style={{padding:"10px 14px"}}>
    <div className={styles.toolbar}>
      <strong>{period ? `${report.toUpperCase()} · ${label}` : "Final submission"}</strong>
      <a href="/team-ops/losses/payment-release" className={styles.button}>Review payment release</a>
      <span>{matching.length ? `${matching.length} station${matching.length===1?"":"s"} closed · read-only` : "Open for updates"}</span>
      {canClose&&period&&open.length>0 ? <button type="button" className={styles.button} onClick={()=>setConfirm(true)} disabled={busy}>Final submit / Close period</button> : null}
      {canClose&&!period ? <span>Select one loss period to finally submit.</span> : null}
    </div>
    {matching.length ? <details><summary>Closed stations · submitted by / time</summary>{matching.map(c=><div key={`${c.period}:${c.station_code}`}>{c.station_code} · {c.period} · {c.closed_by_name} · {new Date(c.closed_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST</div>)}</details> : null}
    {confirm ? <div role="group" aria-label="Confirm final submission" className={styles.notice}>
      <strong>Close {report.toUpperCase()} · {label} for {open.length} stations?</strong>
      <p>{open.join(", ")}</p>
      <p>Locks all cases in these stations for this loss period, including cases hidden by status or reason filters. Later manual changes and bulk updates will be blocked. Downloads and payroll processing remain available.</p>
      <button type="button" className={styles.primary} disabled={busy} onClick={submit}>{busy?"Submitting…":"Confirm final submit"}</button>{" "}
      <button type="button" className={styles.button} disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
