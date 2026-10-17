"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LEDGER_STATUS,
  filterLedger,
  ledgerTotals,
  recoveredPercent,
  type LedgerLine,
} from "@/lib/ops-pulse/nl-recovery-ledger-view";
import { recoveryCsv } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
import { ListPager, usePaged } from "./list-pager";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0);
const monthShort = (m: string | null) =>
  m ? new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const day = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const caseLabel = (l: LedgerLine) => `${l.report.toUpperCase()} · ${monthShort(l.month)} · ${l.case_key.replace(/^slp:/, "")}`;
const lineKey = (l: LedgerLine) => `${l.month}|${l.case_key}|${l.employee_ref}`;

const FILTERS = [
  { key: "open", label: "Outstanding" },
  { key: "exit_balance", label: "Exit balances" },
  { key: "in_progress", label: "Recovering" },
  { key: "scheduled", label: "Scheduled" },
  { key: "recovered", label: "Recovered" },
  { key: "written_off", label: "Written off" },
  { key: "all", label: "All" },
] as const;

export function NlRecoveryLedger({ lines, canWriteOff }: { lines: LedgerLine[]; canWriteOff: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>(lines.some((l) => l.status === "exit_balance") ? "exit_balance" : "open");
  const [query, setQuery] = useState("");
  const [station, setStation] = useState("");
  const [writing, setWriting] = useState<LedgerLine | null>(null);
  const stations = useMemo(() => [...new Set(lines.map((l) => l.station_code))].sort(), [lines]);
  const shown = useMemo(() => filterLedger(lines, { status, query, station }), [lines, status, query, station]);
  const all = useMemo(() => ledgerTotals(lines), [lines]);
  const paged = usePaged(shown, 25, `${status}|${query}|${station}`);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: lines.length, open: filterLedger(lines, { status: "open" }).length };
    for (const l of lines) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [lines]);

  function download() {
    const columns = ["Loss month", "Case", "Report", "Station", "Employee ID", "Name", "Method", "Instalments", "Monthly", "Assigned", "Deducted", "In payroll (not reviewed)", "Written off", "Outstanding", "First salary month", "Last deducted in", "Exit date", "Cap override", "Status", "Write-off reason", "Written off by"];
    const rows = shown.map((l) => [l.month, l.case_key, l.report, l.station_code, l.employee_code, l.full_name, l.recovery_mode === "installments" ? "Recurring debit" : "Full debit", l.installment_count ?? 1, l.monthly_amount, l.total, l.deducted, l.in_payroll, l.waived, l.outstanding, l.first_salary_month, l.last_deducted_in, l.exit_date, l.cap_override ? "Yes" : "No", LEDGER_STATUS[l.status]?.label ?? l.status, l.waiver_reason, l.waived_by_name]);
    const url = URL.createObjectURL(new Blob(["﻿" + [columns, ...rows].map((r) => r.map(recoveryCsv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `loss-recovery-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className={`${styles.metrics} ${styles.metrics4}`}>
        <div>
          <span>Assigned to people</span>
          <strong>{money(all.assigned)}</strong>
          <small>{all.people.toLocaleString("en-IN")} people · {lines.length.toLocaleString("en-IN")} plan lines</small>
        </div>
        <div>
          <span>Deducted in payroll</span>
          <strong>{money(all.deducted)}</strong>
          <small>Reviewed HRMS payroll and published Workforce payouts</small>
        </div>
        <div>
          <span>Outstanding</span>
          <strong>{money(all.outstanding)}</strong>
          <small>Still to recover through payroll{all.waived ? ` · ${money(all.waived)} written off` : ""}</small>
        </div>
        <div>
          <span>Exit balances</span>
          <strong>{money(all.exitBalance)}</strong>
          <small>{all.exitCount ? `${all.exitCount} line${all.exitCount === 1 ? "" : "s"} need an HR decision` : "No exited person owes a balance"}</small>
        </div>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h2>Recovery ledger</h2>
            <p>One line per person per loss: what was assigned, what payroll deducted and what is still due.</p>
          </div>
          <div className={styles.toolbar}>
            <input aria-label="Search the ledger" placeholder="Employee, name, case or station" value={query} onChange={(e) => setQuery(e.target.value)} />
            {stations.length > 1 ? (
              <select aria-label="Station" value={station} onChange={(e) => setStation(e.target.value)}>
                <option value="">All stations</option>
                {stations.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : null}
            <button className={styles.button} onClick={download} disabled={!shown.length}>Download CSV</button>
          </div>
        </div>
        <div className={styles.chips} role="tablist" aria-label="Ledger status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={status === f.key}
              className={status === f.key ? `${styles.chip} ${styles.activeChip}` : styles.chip}
              onClick={() => setStatus(f.key)}
            >
              {f.label} <span className={styles.ledgerCount}>{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        {shown.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.ledgerTable}>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Loss</th>
                  <th>Method</th>
                  <th className={styles.num}>Assigned</th>
                  <th>Progress</th>
                  <th className={styles.num}>Outstanding</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((l) => {
                  const meta = LEDGER_STATUS[l.status] ?? { label: l.status, tone: "info" };
                  const pct = recoveredPercent(l);
                  return (
                    <tr key={lineKey(l)}>
                      <td>
                        <strong>{l.full_name || "Unnamed"}</strong>
                        <small>{l.employee_code || l.employee_ref} · {l.station_code}</small>
                      </td>
                      <td>
                        <span>{caseLabel(l)}</span>
                        <small>{l.outcome_label}{l.updated_by_name ? ` · by ${l.updated_by_name}` : ""}</small>
                      </td>
                      <td>
                        <span>{l.recovery_mode === "installments" ? `${l.installment_count} × ${money(l.monthly_amount)}` : "Full debit"}</span>
                        <small>
                          From {monthShort(l.first_salary_month)}
                          {l.cap_override ? " · cap override" : ""}
                        </small>
                      </td>
                      <td className={styles.num}>{money(l.total)}</td>
                      <td>
                        <div className={styles.progress} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% recovered`}>
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        <small>
                          {money(l.deducted)} deducted
                          {l.recovery_mode === "installments" ? ` · ${l.deducted_count}/${l.installment_count}` : ""}
                          {l.in_payroll ? ` · ${money(l.in_payroll)} in a draft payroll` : ""}
                          {l.last_deducted_in ? ` · last ${monthShort(l.last_deducted_in)}` : ""}
                        </small>
                      </td>
                      <td className={styles.num}>
                        <strong>{money(l.outstanding)}</strong>
                        {l.waived ? <small>{money(l.waived)} written off</small> : null}
                      </td>
                      <td>
                        <span className={`${styles.statusPill} ${styles[`tone_${meta.tone}`]}`}>{meta.label}</span>
                        {l.exit_date ? <small>Exit {day(l.exit_date)}</small> : null}
                        {l.status === "written_off" && l.waiver_reason ? <small title={l.waiver_reason}>By {l.waived_by_name}</small> : null}
                      </td>
                      <td>
                        {canWriteOff && l.status === "exit_balance" && l.outstanding > 0 && !l.in_payroll ? (
                          <button className={styles.button} onClick={() => setWriting(l)}>Write off…</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="lines" />
          </div>
        ) : (
          <p className={styles.empty}>
            {lines.length ? "No recovery lines match these filters." : "No recovery has been assigned to anyone yet. Plans saved in NL Loss and SLP Final appear here."}
          </p>
        )}
        <p className={styles.hint}>
          Recurring debits take one instalment each payroll; a month that cannot carry it moves the rest on. When a person
          exits, every remaining instalment is due in their final settlement. What it cannot recover shows here as an exit
          balance for an HR decision.
        </p>
      </section>
      {writing ? (
        <WriteOffDialog
          line={writing}
          onClose={() => setWriting(null)}
          onDone={() => {
            setWriting(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function WriteOffDialog({ line, onClose, onDone }: { line: LedgerLine; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = reason.trim().length >= 10 && confirm;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/ops-pulse/losses/ledger/write-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: line.month, case_key: line.case_key, employee_ref: line.employee_ref, reason: reason.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.error);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The balance could not be written off.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="write-off-title" onSubmit={submit}>
        <h3 id="write-off-title">Write off exit balance</h3>
        <dl className={styles.dialogFacts}>
          <div><dt>Person</dt><dd>{line.full_name} · {line.employee_code}</dd></div>
          <div><dt>Loss</dt><dd>{caseLabel(line)}</dd></div>
          <div><dt>Exited</dt><dd>{day(line.exit_date)}</dd></div>
          <div><dt>Recovered</dt><dd>{money(line.deducted)} of {money(line.total)}</dd></div>
          <div><dt>To write off</dt><dd><strong>{money(line.outstanding)}</strong></dd></div>
        </dl>
        <label>
          Reason (kept in the case history)
          <textarea rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Full and final settlement could not carry it; approved by HR Manager on 16 Oct." autoFocus />
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          I confirm this balance will no longer be recovered from this person.
        </label>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.button} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.primary} disabled={!valid || busy}>{busy ? "Writing off…" : `Write off ${money(line.outstanding)}`}</button>
        </div>
      </form>
    </div>
  );
}
