"use client";

import { useMemo, useState } from "react";
import styles from "@/components/nl-loss.module.css";
import crw from "@/components/challan-recovery.module.css";
import type {
  ChallanRecoveryCase,
  ChallanRecoveryPerson,
  ChallanRecoveryView
} from "@/lib/ops-pulse/challan-recovery";

const money = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const monthLabel = (m: string) => {
  if (!/^\d{4}-\d{2}$/.test(m)) return m || "—";
  const d = new Date(`${m}-01T12:00:00+05:30`);
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(d);
};

type Row = { ref: string; name: string; amount: string; salaryMonth: string; installmentCount: string };

const statusChip: Record<string, string> = {
  open: "Unassigned",
  assigned: "Assigned",
  recovering: "Recovering",
  recovered: "Recovered",
  closed: "Closed",
  cancelled: "Cancelled"
};

export function ChallanRecoveryWorkspace({ view: initial }: { view: ChallanRecoveryView }) {
  const [view, setView] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<"equal" | "custom">("custom");
  const [rows, setRows] = useState<Row[]>([]);
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Associates + open months are fetched lazily when the assign dialog opens (per station),
  // so the page load stays fast even with thousands of associates.
  const [people, setPeople] = useState<ChallanRecoveryPerson[]>([]);
  const [payrollMonths, setPayrollMonths] = useState<string[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const openCase = useMemo(() => view.cases.find((c) => c.id === openId) || null, [view.cases, openId]);

  const outstanding = view.cases.filter((c) => !["recovered", "closed", "cancelled"].includes(c.status));
  const totalOutstanding = outstanding.reduce((s, c) => s + c.amount, 0);

  async function startAssign(c: ChallanRecoveryCase) {
    setOpenId(c.id);
    setError("");
    setNotice("");
    setSplitMode(c.allocations.length ? c.splitMode : "custom");
    setRows(
      c.allocations.length
        ? c.allocations.map((a) => ({
            ref: a.personRef,
            name: a.personName,
            amount: String(a.amount),
            salaryMonth: a.salaryMonth,
            installmentCount: String(a.installmentCount)
          }))
        : [{ ref: "", name: "", amount: String(c.amount), salaryMonth: "", installmentCount: "1" }]
    );
    setRemarks("");
    // Load the station's associates + open months on demand.
    setOptionsLoading(true);
    setPeople([]);
    setPayrollMonths([]);
    try {
      const res = await fetch(`/api/ops-pulse/losses/challan-recovery?station=${encodeURIComponent(c.stationCode)}`, { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Associates could not be loaded.");
      setPeople(payload.people || []);
      setPayrollMonths(payload.payrollMonths || []);
      if (!c.allocations.length && payload.payrollMonths?.[0]) {
        setRows((r) => r.map((row) => (row.salaryMonth ? row : { ...row, salaryMonth: payload.payrollMonths[0] })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Associates could not be loaded.");
    } finally {
      setOptionsLoading(false);
    }
  }

  function addRow() {
    setRows((r) => [...r, { ref: "", name: "", amount: "", salaryMonth: payrollMonths[0] || "", installmentCount: "1" }]);
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }
  function setRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  // Equal split: divide the case amount across the chosen people.
  function applyEqual(people: number) {
    if (!openCase || people <= 0) return;
    const each = Math.floor((openCase.amount / people) * 100) / 100;
    const last = Math.round((openCase.amount - each * (people - 1)) * 100) / 100;
    setRows((r) => r.map((row, idx) => ({ ...row, amount: String(idx === people - 1 ? last : each) })));
  }

  const assignedTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const overAllocated = openCase ? Math.round(assignedTotal * 100) / 100 > Math.round(openCase.amount * 100) / 100 : false;

  async function save() {
    if (!openCase) return;
    setBusy(true);
    setError("");
    try {
      const allocations = rows
        .filter((r) => r.ref && Number(r.amount) > 0 && r.salaryMonth)
        .map((r) => {
          const person = people.find((p) => p.ref === r.ref);
          const count = Math.max(1, Number(r.installmentCount) || 1);
          const per = Math.round((Number(r.amount) / count) * 100) / 100;
          // Expand installments into one allocation row per instalment.
          return Array.from({ length: count }, (_, k) => ({
            ref: r.ref,
            name: person?.fullName || r.name,
            amount: k === count - 1 ? Math.round((Number(r.amount) - per * (count - 1)) * 100) / 100 : per,
            salary_month: r.salaryMonth,
            installment_no: k + 1,
            installment_count: count
          }));
        })
        .flat();
      if (!allocations.length) throw new Error("Add at least one associate with an amount and salary month.");

      const response = await fetch("/api/ops-pulse/losses/challan-recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: openCase.id, splitMode, allocations, remarks })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Recovery could not be saved.");
      setView(payload.view);
      setNotice(`Recovery assigned for challan ${openCase.challanNumber}.`);
      setOpenId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h2>Challan recovery</h2>
            <small>
              Recover approved traffic challans from the responsible associates — split across people and instalments.
              This is separate from NL/SLP loss recovery; deductions post through the same payroll, under their own keys.
            </small>
          </div>
        </div>

        <div className={crw.stats}>
          <article><small>Outstanding cases</small><strong>{outstanding.length}</strong></article>
          <article><small>Outstanding amount</small><strong>{money(totalOutstanding)}</strong></article>
          <article><small>Assigned</small><strong>{view.cases.filter((c) => c.allocations.length > 0).length}</strong></article>
        </div>

        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {error && !openCase ? <p className={styles.error} role="alert">{error}</p> : null}

        {view.cases.length === 0 ? (
          <div className={styles.empty}>
            <strong>No challan recovery cases yet</strong>
            <p>Approve a challan for recovery in Fleet → Challans to raise a case here.</p>
          </div>
        ) : (
          <div className={crw.list}>
            {view.cases.map((c) => (
              <article key={c.id} className={crw.case}>
                <div className={crw.caseMain}>
                  <div className={crw.caseHead}>
                    <strong className={crw.no}>{c.challanNumber}</strong>
                    <span className={`${crw.chip} ${crw["st"+c.status.charAt(0).toUpperCase()+c.status.slice(1)] || ""}`}>{statusChip[c.status] || c.status}</span>
                  </div>
                  <small className={crw.meta}>
                    {c.vehicleNo} · {c.stationCode} · {monthLabel(c.month)} · {c.offenseDescription || "Traffic challan"}
                  </small>
                  {c.allocations.length ? (
                    <div className={crw.allocs}>
                      {c.allocations
                        .reduce((acc: { ref: string; name: string; total: number; month: string; count: number }[], a) => {
                          const found = acc.find((x) => x.ref === a.personRef && x.month === a.salaryMonth);
                          if (found) { found.total += a.amount; found.count = a.installmentCount; }
                          else acc.push({ ref: a.personRef, name: a.personName, total: a.amount, month: a.salaryMonth, count: a.installmentCount });
                          return acc;
                        }, [])
                        .map((g, i) => (
                          <span key={i} className={crw.alloc}>
                            {g.name || g.ref.split(":")[1]?.slice(0, 8)} · {money(g.total)} · {monthLabel(g.month)}
                            {g.count > 1 ? ` · ${g.count} instalments` : ""}
                          </span>
                        ))}
                    </div>
                  ) : null}
                </div>
                <div className={crw.caseSide}>
                  <div className={crw.amount}>
                    <small>Amount</small>
                    <strong>{money(c.amount)}</strong>
                    {c.allocated > 0 ? <em>{money(c.allocated)} assigned</em> : null}
                  </div>
                  {view.canEdit && !["recovered", "closed", "cancelled"].includes(c.status) ? (
                    <button className={`${styles.button} ${styles.primary}`} type="button" onClick={() => void startAssign(c)}>
                      {c.allocations.length ? "Edit assignment" : "Assign recovery"}
                    </button>
                  ) : (
                    <a className={styles.button} href={c.evidenceUrl || "#"} target="_blank" rel="noreferrer" aria-disabled={!c.evidenceUrl}>
                      Evidence
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {openCase ? (
        <div className={styles.dialogBackdrop}>
          <section className={`${styles.dialog} ${crw.dialog}`} role="dialog" aria-modal="true" aria-label="Assign challan recovery">
            <header className={crw.dialogHead}>
              <div>
                <small>Assign recovery</small>
                <h3>{openCase.challanNumber} · {money(openCase.amount)}</h3>
                <small>{openCase.vehicleNo} · {openCase.stationCode}</small>
              </div>
              <button className={styles.button} type="button" onClick={() => setOpenId(null)} disabled={busy}>Close</button>
            </header>

            <div className={crw.split}>
              <span>Split:</span>
              <button type="button" className={splitMode === "equal" ? `${crw.seg} ${crw.segOn}` : crw.seg} onClick={() => { setSplitMode("equal"); applyEqual(rows.length); }}>Equal</button>
              <button type="button" className={splitMode === "custom" ? `${crw.seg} ${crw.segOn}` : crw.seg} onClick={() => setSplitMode("custom")}>Custom</button>
            </div>

            {optionsLoading ? <p className={crw.total}>Loading associates for {openCase.stationCode}…</p> : null}
            {!optionsLoading && !people.length ? <p className={crw.total}>No assignable associates found for {openCase.stationCode}.</p> : null}

            <div className={crw.rows}>
              {rows.map((row, i) => (
                <div key={i} className={crw.row}>
                  <select
                    value={row.ref}
                    disabled={optionsLoading}
                    onChange={(e) => {
                      const person = people.find((p) => p.ref === e.target.value);
                      setRow(i, { ref: e.target.value, name: person?.fullName || "" });
                    }}
                  >
                    <option value="">Select associate…</option>
                    {people.map((p) => (
                      <option key={p.ref} value={p.ref}>{p.fullName}{p.employeeCode ? ` (${p.employeeCode})` : ""}</option>
                    ))}
                  </select>
                  <input
                    type="number" min="0" step="0.01" placeholder="Amount"
                    value={row.amount} disabled={splitMode === "equal"}
                    onChange={(e) => setRow(i, { amount: e.target.value })}
                  />
                  <select value={row.salaryMonth} onChange={(e) => setRow(i, { salaryMonth: e.target.value })}>
                    <option value="">Salary month…</option>
                    {payrollMonths.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                  </select>
                  <input
                    type="number" min="1" max="24" step="1" title="Instalments"
                    value={row.installmentCount} onChange={(e) => setRow(i, { installmentCount: e.target.value })}
                  />
                  <button type="button" className={crw.x} onClick={() => removeRow(i)} aria-label="Remove">×</button>
                </div>
              ))}
            </div>

            <div className={crw.rowActions}>
              <button type="button" className={styles.button} onClick={() => { addRow(); if (splitMode === "equal") setTimeout(() => applyEqual(rows.length + 1), 0); }}>+ Add associate</button>
              <span className={overAllocated ? `${crw.total} ${crw.totalOver}` : crw.total}>
                {money(assignedTotal)} of {money(openCase.amount)}{overAllocated ? " · exceeds amount" : ""}
              </span>
            </div>

            <label className={crw.remarks}>
              Remarks (optional)
              <textarea rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Context for this recovery." />
            </label>

            {error && openCase ? <p className={styles.error} role="alert">{error}</p> : null}

            <div className={styles.dialogActions}>
              <button type="button" className={styles.button} onClick={() => setOpenId(null)} disabled={busy}>Cancel</button>
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void save()} disabled={busy || overAllocated}>
                {busy ? "Saving…" : "Save assignment"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
