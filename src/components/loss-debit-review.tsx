"use client";
import { ReportTable } from "@/components/report-table";

import { useState } from "react";
import {
  filterLossDebits,
  summarizeLossDebits,
  type LossDebit,
} from "@/lib/ops-pulse/loss-debit-review";
import { deductionMonth, monthLabel } from "@/lib/ops-pulse/nl-loss-policy";
import { indiaMonth } from '@/lib/ops-pulse/loss-recovery-queue-policy';
import styles from "./nl-loss.module.css";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
export function LossDebitReview({ rows, earlierOnly = false, nowMonth }: { rows: LossDebit[]; earlierOnly?: boolean; nowMonth?: string }) {
  const [month, setMonth] = useState(nowMonth || deductionMonth("current_month")!),
    [station, setStation] = useState(""),
    [person, setPerson] = useState(""),
    [designation, setDesignation] = useState(""), [salaryScope, setSalaryScope] = useState(earlierOnly ? 'earlier' : 'selected');
  const currentMonth = nowMonth || indiaMonth();
  const filtered = filterLossDebits(rows, {
    month, salaryScope, currentMonth,
    station,
    person,
    designation,
  });
  const groups = summarizeLossDebits(filtered, station || salaryScope === 'earlier' ? 'person_month' : 'station');
  const trend = summarizeLossDebits(
    filterLossDebits(rows, { station, person, designation }),
    "month",
  );
  const options = filterLossDebits(rows, { station, designation });
  const people = [
    ...new Map(options.map((r) => [r.employee_ref, r])).values(),
  ].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  const params = new URLSearchParams({ month, station, person, designation, salaryScope });
  const totals = filtered.reduce(
    (a, r) => ({
      deducted: a.deducted + (r.payroll_status === "deducted" ? r.amount : 0),
      draft: a.draft + (r.payroll_status === "draft" ? r.amount : 0),
      scheduled: a.scheduled + (r.payroll_status === "scheduled" ? r.amount : 0),
    }),
    { deducted: 0, draft: 0, scheduled: 0 },
  );
  return (
    <>
      <section className={styles.panel}>
        <div
          className={styles.toolbar}
          style={{ padding: 12, flexWrap: "wrap" }}
        >
          <label>
            Salary month
            <input
              disabled={salaryScope === 'earlier'}
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <label>View<select disabled={earlierOnly} value={salaryScope} onChange={e => setSalaryScope(e.target.value)}><option value="selected">Selected salary month</option><option value="earlier">Earlier salary months</option></select></label>
          <label>
            Station
            <select
              value={station}
              onChange={(e) => {
                setStation(e.target.value);
                setPerson("");
              }}
            >
              <option value="">All stations</option>
              {[...new Set(rows.map((r) => r.station_code))].sort().map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Designation
            <select
              value={designation}
              onChange={(e) => {
                setDesignation(e.target.value);
                setPerson("");
              }}
            >
              <option value="">All designations</option>
              {[...new Set(rows.map((r) => r.designation).filter(Boolean))]
                .sort()
                .map((d) => (
                  <option key={d}>{d}</option>
                ))}
            </select>
          </label>
          <label>
            Person
            <select value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">All people</option>
              {people.map((p) => (
                <option key={p.employee_ref} value={p.employee_ref}>
                  {p.full_name} · {p.employee_code}
                </option>
              ))}
            </select>
          </label>
          <a
            className={styles.button}
            href={`/api/ops-pulse/losses/debits/export?${params}`}
          >
            Download Excel
          </a>
        </div>
      </section>
      <div className={`${styles.metrics} ${styles.metrics4}`}>
        <div>
          <span>Deducted · {salaryScope === 'earlier' ? 'earlier salary months' : month ? monthLabel(month) : 'all payrolls'}</span>
          <strong>{money(totals.deducted)}</strong>
        </div>
        <div>
          <span>In draft payroll</span>
          <strong>{money(totals.draft)}</strong>
        </div>
        <div>
          <span>Scheduled for payroll / payout</span>
          <strong>{money(totals.scheduled)}</strong>
          <small>Approved and included in live payable calculation</small>
        </div>
        <div>
          <span>Recipients</span>
          <strong>{new Set(filtered.map((r) => r.employee_ref)).size}</strong>
          <small>{new Set(filtered.filter(r => r.payroll_source === "people").map(r => r.employee_ref)).size} People · {new Set(filtered.filter(r => r.payroll_source === "workforce").map(r => r.employee_ref)).size} Workforce</small>
        </div>
      </div>
      {station && (
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setStation("");
            setPerson("");
          }}
        >
          ← All stations
        </button>
      )}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2>
            {salaryScope === 'earlier' ? 'Earlier payroll / payout months · recipient-wise deductions' : station ? `${station} · Payroll and payout deductions` : 'Station deductions'}
          </h2>
        </div>
        <div className={styles.tableWrap}>
          <ReportTable>
            <thead>
              <tr>
                <th>{station || salaryScope === 'earlier' ? 'Person / designation' : 'Station'}</th>
                {!station && salaryScope !== 'earlier' && <th>Recipients</th>}
                <th>Salary month</th>
                <th>Shipments</th>
                <th>Deducted</th>
                <th>Draft payroll</th>
                <th>Scheduled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>
                    <strong>{g.label}</strong>
                    <small>{g.detail}{salaryScope === 'earlier' ? ` · ${g.stations}` : ''}</small>
                  </td>
                  {!station && salaryScope !== 'earlier' && <td>{g.people}</td>}
                  <td><span className={g.payrollMonth < currentMonth ? styles.earlierSalary : undefined}>{monthLabel(station || salaryScope === 'earlier' ? g.payrollMonth : month) || 'All months'}</span></td>
                  <td>{g.shipments}</td>
                  <td>{money(g.deducted)}</td>
                  <td>{money(g.draft)}</td>
                  <td>{money(g.scheduled)}<small>{money(g.peoplePayroll)} People · {money(g.workforcePayout)} Workforce</small></td>
                  <td>
                    <button
                      className={styles.button}
                      onClick={() =>
                        station || salaryScope === 'earlier' ? setPerson(g.employeeRef) : setStation(g.key)
                      }
                    >
                      {station || salaryScope === 'earlier' ? 'View history' : 'View people'} →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
        {!groups.length && (
          <p className={styles.empty}>
            No payroll or payout recovery is recorded for this period and selection.
            {' '}<a href="/team-ops/losses/recovery">View saved recovery updates and pending collections →</a>
          </p>
        )}
      </section>
      {person && (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>
              {people.find((p) => p.employee_ref === person)?.full_name} ·
              Monthly history
            </h2>
            <button className={styles.button} onClick={() => setPerson("")}>
              Close
            </button>
          </div>
          <div className={styles.tableWrap}>
            <ReportTable>
              <thead>
                <tr>
                  <th>Payroll month</th>
                  <th>Shipments</th>
                  <th>Deducted</th>
                  <th>Draft payroll</th>
                  <th>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.key}>
                    <td>
                      {earlierOnly ? <span className={styles.earlierSalary}>{monthLabel(t.key)}</span> : <button
                        className={styles.button}
                        onClick={() => {setSalaryScope('selected'); setMonth(t.key);}}
                      >
                        {monthLabel(t.key)}
                      </button>}
                    </td>
                    <td>{t.shipments}</td>
                    <td>{money(t.deducted)}</td>
                    <td>{money(t.draft)}</td>
                    <td>{money(t.scheduled)}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </div>
          <details className={styles.compactDetails}>
            <summary>Shipment details · {filtered.length}</summary>
            <div className={styles.tableWrap}>
              <ReportTable>
                <thead>
                  <tr>
                    <th>Shipment ID</th>
                    <th>Loss month</th>
                    <th>Salary month</th>
                    <th>Amount</th>
                    <th>Payroll source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.recovery_key}>
                      <td>{r.shipment_id || r.case_key.replace(/^slp:/, "")}</td>
                      <td>{r.loss_month}</td>
                      <td><span className={r.payroll_month < currentMonth ? styles.earlierSalary : undefined}>{monthLabel(r.payroll_month)}</span></td>
                      <td>{money(r.amount)}</td>
                      <td>{r.payroll_source === "workforce" ? "Workforce payout" : "People payroll"}</td>
                      <td>{r.payroll_status === "deducted" ? "Deducted" : r.payroll_status === "draft" ? "Draft payroll" : "Scheduled"}</td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            </div>
          </details>
        </section>
      )}
    </>
  );
}
