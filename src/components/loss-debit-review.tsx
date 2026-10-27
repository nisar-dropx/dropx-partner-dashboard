"use client";
import { useState } from "react";
import {
  filterLossDebits,
  summarizeLossDebits,
  type LossDebit,
} from "@/lib/ops-pulse/loss-debit-review";
import { deductionMonth, monthLabel } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
export function LossDebitReview({ rows }: { rows: LossDebit[] }) {
  const [month, setMonth] = useState(deductionMonth("current_month")!),
    [station, setStation] = useState(""),
    [person, setPerson] = useState(""),
    [designation, setDesignation] = useState("");
  const filtered = filterLossDebits(rows, {
    month,
    station,
    person,
    designation,
  });
  const groups = summarizeLossDebits(filtered, station ? "person" : "station");
  const trend = summarizeLossDebits(
    filterLossDebits(rows, { station, person, designation }),
    "month",
  );
  const options = filterLossDebits(rows, { station, designation });
  const people = [
    ...new Map(options.map((r) => [r.employee_ref, r])).values(),
  ].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  const params = new URLSearchParams({ month, station, person, designation });
  const totals = filtered.reduce(
    (a, r) => ({
      deducted: a.deducted + (r.is_deducted ? r.amount : 0),
      draft: a.draft + (r.is_deducted ? 0 : r.amount),
    }),
    { deducted: 0, draft: 0 },
  );
  return (
    <>
      <section className={styles.panel}>
        <div
          className={styles.toolbar}
          style={{ padding: 12, flexWrap: "wrap" }}
        >
          <label>
            Debit month
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
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
      <div className={styles.metrics}>
        <div>
          <span>Deducted · {month ? monthLabel(month) : "all payrolls"}</span>
          <strong>{money(totals.deducted)}</strong>
        </div>
        <div>
          <span>In draft payroll</span>
          <strong>{money(totals.draft)}</strong>
        </div>
        <div>
          <span>People</span>
          <strong>{new Set(filtered.map((r) => r.employee_ref)).size}</strong>
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
            {station ? `${station} · People deductions` : "Station deductions"}
          </h2>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>{station ? "Person / designation" : "Station"}</th>
                {!station && <th>People</th>}
                <th>Shipments</th>
                <th>Deducted</th>
                <th>Draft payroll</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>
                    <strong>{g.label}</strong>
                    <small>{g.detail}</small>
                  </td>
                  {!station && <td>{g.people}</td>}
                  <td>{g.shipments}</td>
                  <td>{money(g.deducted)}</td>
                  <td>{money(g.draft)}</td>
                  <td>
                    <button
                      className={styles.button}
                      onClick={() =>
                        station ? setPerson(g.key) : setStation(g.key)
                      }
                    >
                      {station ? "View history" : "View people"} →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!groups.length && (
          <p className={styles.empty}>
            No deductions recorded for this payroll month and selection.
            Recovery plans remain visible in Balances.
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
            <table>
              <thead>
                <tr>
                  <th>Payroll month</th>
                  <th>Shipments</th>
                  <th>Deducted</th>
                  <th>Draft payroll</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.key}>
                    <td>
                      <button
                        className={styles.button}
                        onClick={() => setMonth(t.key)}
                      >
                        {monthLabel(t.key)}
                      </button>
                    </td>
                    <td>{t.shipments}</td>
                    <td>{money(t.deducted)}</td>
                    <td>{money(t.draft)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className={styles.compactDetails}>
            <summary>Shipment details · {filtered.length}</summary>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Shipment ID</th>
                    <th>Loss month</th>
                    <th>Debit month</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.recovery_key}>
                      <td>{r.shipment_id || r.case_key.replace(/^slp:/, "")}</td>
                      <td>{r.loss_month}</td>
                      <td>{r.payroll_month}</td>
                      <td>{money(r.amount)}</td>
                      <td>{r.is_deducted ? "Deducted" : "Draft payroll"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </>
  );
}
