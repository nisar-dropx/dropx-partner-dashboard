"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Files, Info, RefreshCw, WalletCards } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";
import type { InterimSalary } from "../lib/interim-salary";
import styles from "./connect-interim-salary.module.css";

const money = (amount: number | null) => amount == null ? "—" : amount.toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const date = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const paymentLabels: Record<string, string> = { paid: "Bank confirmed", issued: "Confirmation pending", failed: "Failed / replaced", returned: "Returned" };

export function ConnectInterimSalary({ account, onDocuments, onAttendance }: { account: AppAccount; onDocuments: () => void; onAttendance?: () => void }) {
  const [rows, setRows] = useState<InterimSalary[]>([]);
  const [selected, setSelected] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setRows([]); setLoading(true); setError("");
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
    fetch(`/api/connect/salary?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.salaries)) throw new Error(body.error || "Unable to load salary details.");
        if (!controller.signal.aborted) setRows(body.salaries);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load salary details."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [account.id, account.companyId, account.profileType, attempt]);
  const salary = rows.find(row => row.id === selected) ?? rows[0];

  return <section className={styles.page} aria-busy={loading}>
    <header className={styles.header}>
      <div><small>PAYMENTS</small><h1>Interim salary</h1><p>Your current payroll breakup and payment updates.</p></div>
      <div className={styles.controls}>
        {rows.length ? <label>Salary period<select value={salary.id} onChange={event => setSelected(event.target.value)}>{rows.map(row => <option key={row.id} value={row.id}>{row.label || `${date(row.periodStart)} – ${date(row.periodEnd)}`}</option>)}</select></label> : null}
        <button type="button" aria-label="Refresh salary" disabled={loading} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={18}/></button>
      </div>
    </header>
    <aside className={styles.notice}><Info size={20}/><div><strong>This is not your final salary.</strong><p>Final salary details will appear in your payslip under Documents once published. This is only an interim view.</p></div></aside>
    {loading ? <div className={styles.empty} role="status">Loading salary…</div> : error ? <div className={styles.empty} role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : !salary ? <div className={styles.empty}><WalletCards/><h2>No interim salary yet</h2><p>Your breakup will appear when a salary payment is prepared.</p></div> : <>
      <div className={styles.summary}>
        <article className={styles.net}><span>Interim net amount</span><strong>{money(salary.payable)}</strong><small>{date(salary.periodStart)} – {date(salary.periodEnd)}</small></article>
        <article><span>Paid so far</span><strong>{money(salary.paid)}</strong><small>Bank-confirmed payments only</small></article>
        <article><span>Confirmation pending</span><strong>{money(salary.awaitingConfirmation)}</strong><small>Payment file issued · not yet confirmed</small></article>
      </div>
      {salary.exceedsCurrentCalculation ? <p className={styles.caution}>Paid amount exceeds the current calculation. People will reconcile this before finalisation.</p> : salary.paid > 0 && (salary.unconfirmedBalance ?? 0) > 0 ? <p className={styles.caution}>Difference vs current calculation: <b>{money(salary.unconfirmedBalance)}</b> · Subject to review; not a confirmed next payment.</p> : null}
      <div className={styles.card}>
        <details open key={`breakup-${salary.id}`}>
          <summary>Salary breakup <ChevronRight size={18}/></summary>
          {salary.net == null ? <p className={styles.helper}>The breakup is unavailable. Payment history is shown below.</p> : <>
            <div className={styles.breakup}>
              <section><h3>Earnings</h3>{salary.earnings.map((row, index) => <div className={styles.line} key={index}><span>{row.name}</span><b>{money(row.amount)}</b></div>)}<div className={styles.total}><span>Total earnings</span><b>{money(salary.totalEarnings)}</b></div></section>
              <section><h3>Deductions</h3>{salary.deductions.length ? salary.deductions.map((row, index) => <div className={styles.line} key={index}><span>{row.name}</span><b>{money(row.amount)}</b></div>) : <p className={styles.helper}>No deductions in this calculation.</p>}<div className={styles.total}><span>Total deductions</span><b>{money(salary.deductionTotal)}</b></div></section>
            </div>
            {salary.reconciliation !== 0 ? <div className={styles.line}><span>Payroll adjustment / rounding</span><b>{money(salary.reconciliation)}</b></div> : null}
            {salary.hold > 0 ? <div className={styles.line}><span>Salary on hold</span><b>{money(salary.hold)}</b></div> : null}
            <div className={styles.netLine}><span>Interim net amount</span><strong>{money(salary.payable)}</strong></div>
          </>}
        </details>
        {salary.calculatedAt ? <p className={styles.helper}>Payroll snapshot updated {new Date(salary.calculatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST.</p> : null}
      </div>
      {salary.attendance ? <div className={styles.card}><details key={`attendance-${salary.id}`}><summary><span>Days used in payroll <b>{salary.attendance.payable} / {salary.attendance.expected}</b></span><ChevronRight size={18}/></summary><div className={styles.days}>{[
        ["Present", salary.attendance.present], ["Half days", salary.attendance.half], ["Absent", salary.attendance.absent], ["Paid leave", salary.attendance.leave], ["Week off", salary.attendance.weekoff], ["Missing punches", salary.attendance.missingPunches]
      ].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div><p className={styles.helper}>Calculation: {date(salary.calculatedFrom)} – {date(salary.calculatedThrough)}. Attendance corrections appear here after payroll is recalculated.</p>{onAttendance ? <button className={styles.textButton} onClick={onAttendance}>Review attendance <ChevronRight size={16}/></button> : null}</details></div> : null}
      <div className={styles.card}><details open key={`history-${salary.id}`}><summary>Payment history <ChevronRight size={18}/></summary>{salary.history.length ? <ul className={styles.history}>{salary.history.map(row => <li key={row.id}><div><strong>{money(row.amount)}</strong><span className={row.status === "paid" ? styles.paid : styles.pending}>{paymentLabels[row.status] ?? "Under review"}</span></div><small>Value date {date(row.date)} · {row.utr ? `UTR ${row.utr}` : `Reference ${row.reference}`}</small></li>)}</ul> : <p className={styles.helper}>No bank-confirmed payment recorded.</p>}</details></div>
    </>}
    <button className={styles.documents} onClick={onDocuments}><Files size={20}/><span><strong>Final payslip</strong><small>{salary?.documentId ? "Published · View in Documents" : "Available in Documents once published"}</small></span><ChevronRight size={20}/></button>
  </section>;
}
