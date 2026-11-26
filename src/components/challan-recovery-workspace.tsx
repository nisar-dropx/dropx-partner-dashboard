"use client";

import { useMemo, useState } from "react";
import styles from "@/components/nl-loss.module.css";
import crw from "@/components/challan-recovery.module.css";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import "@/components/loss-list-controls.css";
import { ListPager, usePaged } from "@/components/list-pager";
import { useOpsReportExport } from "@/components/ops-design-context";
import type { ExcelReport } from "@/lib/download-report-excel";
import type {
  ChallanRecoveryCase,
  ChallanRecoveryPerson,
  ChallanRecoveryView
} from "@/lib/ops-pulse/challan-recovery";
import {
  challanRecoveryFacetOptions,
  challanRecoveryFacts,
  challanRecoverySearchHaystack,
  emptyChallanRecoveryFilters,
  filterChallanRecoveryCases,
  type ChallanRecoveryDimension,
  type ChallanRecoveryFilters
} from "@/lib/ops-pulse/challan-recovery-filters";
import { monthLabel as payrollMonthLabel } from "@/lib/ops-pulse/nl-loss-policy";

const money = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const monthLabel = (m: string) => {
  if (!/^\d{4}-\d{2}$/.test(m)) return m || "—";
  return payrollMonthLabel(m);
};

type Row = { ref: string; name: string; amount: string; salaryMonth: string; installmentCount: string };

const statusChip: Record<string, string> = {
  open: "Unassigned",
  assigned: "Assigned",
  recovering: "Recovering",
  bank_pending: "Bank deposit · verify",
  recovered: "Recovered",
  closed: "Closed",
  cancelled: "Cancelled"
};

const allocationStatusChip: Record<string, string> = {
  planned: "Scheduled",
  scheduled: "Scheduled",
  draft: "Draft payroll",
  deducted: "Deducted",
  recovered: "Deducted",
  cancelled: "Cancelled",
  waived: "Waived"
};

function titleCaseStatus(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function caseStatusLabel(status: string) {
  return statusChip[status] || titleCaseStatus(status || "unknown");
}

function allocationStatusLabel(status: string) {
  return allocationStatusChip[status] || titleCaseStatus(status || "unknown");
}

function caseChipClass(status: string) {
  const key = status.charAt(0).toUpperCase() + status.slice(1);
  return crw[`st${key}` as keyof typeof crw] || "";
}

function deductedAllocated(c: ChallanRecoveryCase) {
  return c.allocations
    .filter((a) => ["deducted", "recovered"].includes(a.status))
    .reduce((sum, a) => sum + a.amount, 0);
}

const FILTER_LABELS: [ChallanRecoveryDimension, string][] = [
  ["station", "Station"],
  ["status", "Status"],
  ["month", "Recovery month"]
];

function allocationSummary(c: ChallanRecoveryCase) {
  return c.allocations.reduce(
    (acc: { ref: string; name: string; total: number; month: string; count: number; status: string }[], a) => {
      const found = acc.find(
        (x) => x.ref === a.personRef && x.month === a.salaryMonth && x.status === a.status
      );
      if (found) {
        found.total += a.amount;
        found.count = Math.max(found.count, a.installmentCount);
      } else {
        acc.push({
          ref: a.personRef,
          name: a.personName,
          total: a.amount,
          month: a.salaryMonth,
          count: a.installmentCount,
          status: a.status
        });
      }
      return acc;
    },
    []
  );
}

export function ChallanRecoveryWorkspace({ view: initial }: { view: ChallanRecoveryView }) {
  const [view, setView] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<"payroll" | "bank_deposit">("payroll");
  const [splitMode, setSplitMode] = useState<"equal" | "custom">("custom");
  const [rows, setRows] = useState<Row[]>([]);
  const [remarks, setRemarks] = useState("");
  const [bankAmount, setBankAmount] = useState("");
  const [bankTxn, setBankTxn] = useState("");
  const [bankDate, setBankDate] = useState("");
  const [bankAttachments, setBankAttachments] = useState<{ id: string; file_name: string }[]>([]);
  const [returnNote, setReturnNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [people, setPeople] = useState<ChallanRecoveryPerson[]>([]);
  const [payrollMonths, setPayrollMonths] = useState<string[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ChallanRecoveryFilters>(emptyChallanRecoveryFilters);
  const [exporting, setExporting] = useState(false);
  const mayExport = useOpsReportExport();

  const openCase = useMemo(() => view.cases.find((c) => c.id === openId) || null, [view.cases, openId]);

  const searchedFacts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = needle
      ? view.cases.filter((row) => challanRecoverySearchHaystack(row).includes(needle))
      : view.cases;
    return base.map(challanRecoveryFacts);
  }, [view.cases, query]);

  const facets = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(filters) as ChallanRecoveryDimension[]).map((key) => [
          key,
          challanRecoveryFacetOptions(searchedFacts, filters, key)
        ])
      ) as Record<ChallanRecoveryDimension, string[]>,
    [searchedFacts, filters]
  );

  const shown = useMemo(
    () => filterChallanRecoveryCases(view.cases, filters, query),
    [view.cases, filters, query]
  );
  const paged = usePaged(
    shown,
    25,
    `${query}|${filters.station.join(",")}|${filters.status.join(",")}|${filters.month.join(",")}`
  );

  const outstanding = shown.filter((c) => !["recovered", "closed", "cancelled"].includes(c.status));
  const totalOutstanding = outstanding.reduce(
    (s, c) => s + Math.max(0, c.amount - deductedAllocated(c)),
    0
  );
  const assignedCount = shown.filter((c) => c.allocations.length > 0).length;
  const filtersActive =
    Boolean(query.trim()) || filters.station.length > 0 || filters.status.length > 0 || filters.month.length > 0;

  function exportReport(): ExcelReport {
    return {
      title: "Challan recovery",
      scope: `All ${shown.length} matching cases; search: ${query.trim() || "none"}; filters: ${JSON.stringify(filters)}`,
      headers: [
        "Challan number",
        "Vehicle",
        "Station",
        "Recovery month",
        "Status",
        "Amount (INR)",
        "Allocated (INR)",
        "Offense",
        "Issuing authority",
        "Approved by",
        "Approved at (IST)",
        "Evidence URL",
        "Assignees",
        "Salary months",
        "Split mode"
      ],
      rows: shown.map((c) => {
        const groups = allocationSummary(c);
        return [
          c.challanNumber,
          c.vehicleNo,
          c.stationCode,
          c.month,
          caseStatusLabel(c.status),
          c.amount,
          c.allocated,
          c.offenseDescription,
          c.issuingAuthority,
          c.approvedByName,
          c.approvedAt
            ? new Date(c.approvedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
            : "",
          c.evidenceUrl,
          groups.map((g) => `${g.name || g.ref} (${money(g.total)}${g.count > 1 ? ` · ${g.count} instalments` : ""})`).join("; "),
          groups.map((g) => monthLabel(g.month)).join("; "),
          c.splitMode
        ];
      })
    };
  }

  async function download() {
    if (!mayExport || exporting) return;
    setExporting(true);
    try {
      const { downloadReportExcel } = await import("@/lib/download-report-excel");
      await downloadReportExcel(exportReport());
    } catch {
      setError("Excel export unavailable. Please retry.");
    } finally {
      setExporting(false);
    }
  }

  async function startAssign(c: ChallanRecoveryCase) {
    setOpenId(c.id);
    setError("");
    setNotice("");
    setReturnNote("");
    setRecoveryMode(c.status === "bank_pending" || c.bankDeposit?.approvalStatus === "returned" ? "bank_deposit" : "payroll");
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
    setRemarks(c.bankDeposit?.remarks || "");
    setBankAmount(c.bankDeposit?.receivedAmount || String(c.amount));
    setBankTxn(c.bankDeposit?.receiptReference || "");
    setBankDate(c.bankDeposit?.receivedDate || "");
    setBankAttachments(c.bankDeposit?.attachments || []);
    setOptionsLoading(true);
    setPeople([]);
    setPayrollMonths([]);
    try {
      const res = await fetch(
        `/api/ops-pulse/losses/challan-recovery?station=${encodeURIComponent(c.stationCode)}`,
        { cache: "no-store" }
      );
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

  async function uploadBankProof(files: FileList | null) {
    if (!openCase || !files?.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        form.set("caseId", openCase.id);
        const res = await fetch("/api/ops-pulse/losses/challan-recovery", { method: "POST", body: form });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Proof upload failed.");
        setBankAttachments((current) => [...current, payload.attachment]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proof upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function reviewBank(reviewAction: "approve" | "return") {
    if (!openCase) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ops-pulse/losses/challan-recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "bank_review",
          caseId: openCase.id,
          reviewAction,
          note: returnNote,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Bank deposit review failed.");
      setView(payload.view);
      setNotice(
        reviewAction === "approve"
          ? `Bank deposit verified for challan ${openCase.challanNumber}.`
          : `Bank deposit returned for challan ${openCase.challanNumber}.`,
      );
      setOpenId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bank deposit review failed.");
    } finally {
      setBusy(false);
    }
  }

  function addRow() {
    setRows((current) => {
      const next = [
        ...current,
        { ref: "", name: "", amount: "", salaryMonth: payrollMonths[0] || "", installmentCount: "1" }
      ];
      if (splitMode !== "equal" || !openCase || !next.length) return next;
      const each = Math.floor((openCase.amount / next.length) * 100) / 100;
      const last = Math.round((openCase.amount - each * (next.length - 1)) * 100) / 100;
      return next.map((row, idx) => ({
        ...row,
        amount: String(idx === next.length - 1 ? last : each)
      }));
    });
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }
  function setRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function applyEqual(peopleCount: number) {
    if (!openCase || peopleCount <= 0) return;
    const each = Math.floor((openCase.amount / peopleCount) * 100) / 100;
    const last = Math.round((openCase.amount - each * (peopleCount - 1)) * 100) / 100;
    setRows((r) => r.map((row, idx) => ({ ...row, amount: String(idx === peopleCount - 1 ? last : each) })));
  }

  const assignedTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const overAllocated = openCase
    ? Math.round(assignedTotal * 100) / 100 > Math.round(openCase.amount * 100) / 100
    : false;

  async function save() {
    if (!openCase) return;
    setBusy(true);
    setError("");
    try {
      if (recoveryMode === "bank_deposit") {
        if (!view.canBankDeposit) throw new Error("Only Cluster Manager and above can submit a bank deposit.");
        const response = await fetch("/api/ops-pulse/losses/challan-recovery", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "bank_deposit",
            caseId: openCase.id,
            remarks,
            recovery_details: {
              received_amount: bankAmount,
              receipt_reference: bankTxn,
              received_date: bankDate,
              attachments: bankAttachments,
            },
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Bank deposit could not be saved.");
        setView(payload.view);
        setNotice(`Bank deposit submitted for challan ${openCase.challanNumber}. Awaiting SLP verification.`);
        setOpenId(null);
        return;
      }

      const allocations = rows
        .filter((r) => r.ref && Number(r.amount) > 0 && r.salaryMonth)
        .map((r) => {
          const person = people.find((p) => p.ref === r.ref);
          const count = Math.max(1, Number(r.installmentCount) || 1);
          const per = Math.round((Number(r.amount) / count) * 100) / 100;
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
              Recover approved traffic challans from associates via payroll, or submit a bank deposit for SLP verification.
              This is separate from NL/SLP loss recovery; payroll deductions use their own keys.
            </small>
          </div>
          <div className={styles.toolbar}>
            <input
              aria-label="Search challan recovery"
              placeholder="Challan, vehicle, station, person…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {mayExport ? (
              <button type="button" className={styles.button} disabled={exporting || !shown.length} onClick={() => void download()}>
                {exporting ? "Preparing…" : `Excel · ${shown.length.toLocaleString("en-IN")}`}
              </button>
            ) : null}
          </div>
        </div>

        <div className={`${styles.toolbar} ${crw.filters}`} style={{ padding: "0 0 12px", flexWrap: "wrap" }}>
          {FILTER_LABELS.map(([key, label]) => (
            <div className="loss-multi-filter" key={key}>
              <FleetMultiSelect
                label={label}
                allLabel={`All ${label.toLowerCase()}s`}
                alwaysSearch
                values={filters[key]}
                options={facets[key].map((value) => ({
                  value,
                  label: key === "status" ? caseStatusLabel(value) : key === "month" ? monthLabel(value) : value
                }))}
                onChange={(values) => setFilters((current) => ({ ...current, [key]: values }))}
              />
            </div>
          ))}
          {filtersActive ? (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setFilters(emptyChallanRecoveryFilters());
                setQuery("");
              }}
            >
              Reset
            </button>
          ) : null}
        </div>

        <div className={crw.stats}>
          <article>
            <small>{filtersActive ? "Matching cases" : "Outstanding cases"}</small>
            <strong>{filtersActive ? shown.length : outstanding.length}</strong>
          </article>
          <article>
            <small>{filtersActive ? "Outstanding in results" : "Outstanding amount"}</small>
            <strong>{money(totalOutstanding)}</strong>
          </article>
          <article>
            <small>Assigned</small>
            <strong>{assignedCount}</strong>
          </article>
        </div>

        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
        {error && !openCase ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {view.cases.length === 0 ? (
          <div className={styles.empty}>
            <strong>No challan recovery cases yet</strong>
            <p>Approve a challan for recovery in Fleet → Challans to raise a case here.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className={styles.empty}>No challan recovery cases match this search and filter selection.</p>
        ) : (
          <>
            <div className={crw.list}>
              {paged.rows.map((c) => (
                <article key={c.id} className={crw.case}>
                  <div className={crw.caseMain}>
                    <div className={crw.caseHead}>
                      <strong className={crw.no}>{c.challanNumber}</strong>
                      <span className={`${crw.chip} ${caseChipClass(c.status)}`}>
                        {caseStatusLabel(c.status)}
                      </span>
                    </div>
                    <small className={crw.meta}>
                      {c.offenseDescription || "Traffic challan"} · {c.vehicleNo} · {c.stationCode} · {monthLabel(c.month)}
                    </small>
                    {c.allocations.length ? (
                      <div className={crw.allocs}>
                        {allocationSummary(c).map((g, i) => (
                          <span key={i} className={crw.alloc}>
                            {g.name || g.ref.split(":")[1]?.slice(0, 8)} · {money(g.total)} · {monthLabel(g.month)}
                            {g.count > 1 ? ` · ${g.count} instalments` : ""}
                            {" · "}
                            {allocationStatusLabel(g.status)}
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
                    {c.status === "bank_pending" && c.bankDeposit ? (
                      <div className={crw.allocs}>
                        <span className={crw.alloc}>
                          Txn {c.bankDeposit.receiptReference} · {money(Number(c.bankDeposit.receivedAmount) || 0)} · {c.bankDeposit.receivedDate}
                        </span>
                      </div>
                    ) : null}
                    {view.canEdit && !["recovered", "closed", "cancelled"].includes(c.status) ? (
                      <button
                        className={`${styles.button} ${styles.primary}`}
                        type="button"
                        onClick={() => void startAssign(c)}
                      >
                        {c.status === "bank_pending"
                          ? view.canApproveBankDeposit
                            ? "Verify bank deposit"
                            : "View bank deposit"
                          : c.allocations.length
                            ? "Edit assignment"
                            : "Assign recovery"}
                      </button>
                    ) : (
                      <a
                        className={styles.button}
                        href={c.evidenceUrl || "#"}
                        target="_blank"
                        rel="noreferrer"
                        aria-disabled={!c.evidenceUrl}
                      >
                        Evidence
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <ListPager
              page={paged.page}
              pages={paged.pages}
              size={paged.size}
              total={paged.total}
              onPage={paged.setPage}
              onSize={paged.setSize}
              label="challans"
            />
          </>
        )}
      </section>

      {openCase ? (
        <div className={styles.dialogBackdrop}>
          <section
            className={`${styles.dialog} ${crw.dialog}`}
            role="dialog"
            aria-modal="true"
            aria-label="Assign challan recovery"
          >
            <header className={crw.dialogHead}>
              <div>
                <small>{openCase.status === "bank_pending" ? "Verify bank deposit" : "Assign recovery"}</small>
                <h3>
                  {openCase.challanNumber} · {openCase.offenseDescription || "Traffic challan"}
                </h3>
                <small>
                  {money(openCase.amount)} · {openCase.vehicleNo} · {openCase.stationCode}
                </small>
              </div>
              <button className={styles.button} type="button" onClick={() => setOpenId(null)} disabled={busy}>
                Close
              </button>
            </header>

            {openCase.status !== "bank_pending" && (view.canBankDeposit || recoveryMode === "bank_deposit") ? (
              <div className={crw.split}>
                <span>Recovery action:</span>
                <button
                  type="button"
                  className={recoveryMode === "payroll" ? `${crw.seg} ${crw.segOn}` : crw.seg}
                  onClick={() => setRecoveryMode("payroll")}
                  disabled={busy}
                >
                  Recover from employees
                </button>
                {view.canBankDeposit ? (
                  <button
                    type="button"
                    className={recoveryMode === "bank_deposit" ? `${crw.seg} ${crw.segOn}` : crw.seg}
                    onClick={() => setRecoveryMode("bank_deposit")}
                    disabled={busy}
                  >
                    Bank deposit
                  </button>
                ) : null}
              </div>
            ) : null}

            {recoveryMode === "bank_deposit" || openCase.status === "bank_pending" ? (
              <div className={crw.rows}>
                {openCase.status === "bank_pending" && openCase.bankDeposit ? (
                  <p className={crw.total}>
                    Submitted by {openCase.bankDeposit.proposedByName || "ops"} · awaiting independent verification.
                    {openCase.bankDeposit.approvalNote ? ` Last note: ${openCase.bankDeposit.approvalNote}` : ""}
                  </p>
                ) : null}
                {openCase.bankDeposit?.approvalStatus === "returned" ? (
                  <p className={styles.error} role="status">
                    Returned: {openCase.bankDeposit.approvalNote || "Correct the bank deposit and resubmit."}
                  </p>
                ) : null}
                <label className={crw.remarks}>
                  Amount
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={bankAmount}
                    disabled={busy || openCase.status === "bank_pending"}
                    onChange={(e) => setBankAmount(e.target.value)}
                  />
                </label>
                <label className={crw.remarks}>
                  Transaction number
                  <input
                    minLength={5}
                    maxLength={160}
                    value={bankTxn}
                    disabled={busy || openCase.status === "bank_pending"}
                    onChange={(e) => setBankTxn(e.target.value)}
                    placeholder="Bank UTR / transaction reference"
                  />
                </label>
                <label className={crw.remarks}>
                  Received date
                  <input
                    type="date"
                    value={bankDate}
                    disabled={busy || openCase.status === "bank_pending"}
                    onChange={(e) => setBankDate(e.target.value)}
                  />
                </label>
                {openCase.status !== "bank_pending" ? (
                  <label className={crw.remarks}>
                    Screenshot / proof (required)
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      disabled={busy || uploading}
                      onChange={(e) => {
                        void uploadBankProof(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                ) : null}
                {uploading ? <p className={crw.total}>Uploading proof…</p> : null}
                {bankAttachments.map((a) => (
                  <div key={a.id} className={crw.rowActions}>
                    <a
                      href={`/api/ops-pulse/losses/challan-recovery?case=${encodeURIComponent(openCase.id)}&attachment=${encodeURIComponent(a.id)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.file_name}
                    </a>
                    {openCase.status !== "bank_pending" ? (
                      <button
                        type="button"
                        className={styles.button}
                        onClick={() => setBankAttachments((current) => current.filter((f) => f.id !== a.id))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                {openCase.status !== "bank_pending" ? (
                  <label className={crw.remarks}>
                    Remarks (optional)
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      placeholder="Context for this bank deposit."
                    />
                  </label>
                ) : null}
                {openCase.status === "bank_pending" && view.canApproveBankDeposit ? (
                  <label className={crw.remarks}>
                    Return note (required to return)
                    <textarea
                      rows={2}
                      maxLength={2000}
                      minLength={10}
                      value={returnNote}
                      onChange={(e) => setReturnNote(e.target.value)}
                      placeholder="What must be corrected on this proof?"
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <>
                <div className={crw.split}>
                  <span>Split:</span>
                  <button
                    type="button"
                    className={splitMode === "equal" ? `${crw.seg} ${crw.segOn}` : crw.seg}
                    onClick={() => {
                      setSplitMode("equal");
                      applyEqual(rows.length);
                    }}
                  >
                    Equal
                  </button>
                  <button
                    type="button"
                    className={splitMode === "custom" ? `${crw.seg} ${crw.segOn}` : crw.seg}
                    onClick={() => setSplitMode("custom")}
                  >
                    Custom
                  </button>
                </div>

                {optionsLoading ? <p className={crw.total}>Loading associates for {openCase.stationCode}…</p> : null}
                {!optionsLoading && !people.length ? (
                  <p className={crw.total}>No assignable associates found for {openCase.stationCode}.</p>
                ) : null}

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
                          <option key={p.ref} value={p.ref}>
                            {p.fullName}
                            {p.employeeCode ? ` (${p.employeeCode})` : ""}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Amount"
                        value={row.amount}
                        disabled={splitMode === "equal"}
                        onChange={(e) => setRow(i, { amount: e.target.value })}
                      />
                      <select value={row.salaryMonth} onChange={(e) => setRow(i, { salaryMonth: e.target.value })}>
                        <option value="">Salary month…</option>
                        {payrollMonths.map((m) => (
                          <option key={m} value={m}>
                            {monthLabel(m)}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="1"
                        max="24"
                        step="1"
                        title="Instalments"
                        value={row.installmentCount}
                        onChange={(e) => setRow(i, { installmentCount: e.target.value })}
                      />
                      <button type="button" className={crw.x} onClick={() => removeRow(i)} aria-label="Remove">
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <div className={crw.rowActions}>
                  <button type="button" className={styles.button} onClick={addRow}>
                    + Add associate
                  </button>
                  <span className={overAllocated ? `${crw.total} ${crw.totalOver}` : crw.total}>
                    {money(assignedTotal)} of {money(openCase.amount)}
                    {overAllocated ? " · exceeds amount" : ""}
                  </span>
                </div>

                <label className={crw.remarks}>
                  Remarks (optional)
                  <textarea
                    rows={2}
                    maxLength={1000}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Context for this recovery."
                  />
                </label>
              </>
            )}

            {error && openCase ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            <div className={styles.dialogActions}>
              <button type="button" className={styles.button} onClick={() => setOpenId(null)} disabled={busy}>
                Cancel
              </button>
              {openCase.status === "bank_pending" && view.canApproveBankDeposit ? (
                <>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy || returnNote.trim().length < 10}
                    onClick={() => void reviewBank("return")}
                  >
                    Return for correction
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.primary}`}
                    disabled={busy}
                    onClick={() => void reviewBank("approve")}
                  >
                    {busy ? "Saving…" : "Verify bank deposit"}
                  </button>
                </>
              ) : openCase.status === "bank_pending" ? null : (
                <button
                  type="button"
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => void save()}
                  disabled={busy || uploading || (recoveryMode === "payroll" && overAllocated)}
                >
                  {busy
                    ? "Saving…"
                    : recoveryMode === "bank_deposit"
                      ? "Submit bank deposit"
                      : "Save assignment"}
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
