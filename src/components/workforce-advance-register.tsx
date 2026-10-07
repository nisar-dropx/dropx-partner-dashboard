"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { WorkforceAdvanceBulkUpload } from "@/components/workforce-advance-bulk-upload";

export type WorkforceAdvanceRegisterRow = {
  id: string;
  advanceNumber: string;
  advanceDate: string;
  dropxId: string;
  workforceName: string;
  designation: string;
  location: string;
  paidLocation: string;
  total: number;
  deducted: number;
  pending: number;
  status: "Pending" | "Partially deducted" | "Fully deducted";
  paymentMode: string;
  paymentReference: string;
  externalReference: string;
  remark: string;
  source: string;
  createdAt: string;
  recoveryHistory: Array<{
    id: string;
    periodStart: string;
    periodEnd: string;
    amount: number;
    type: string;
    status: string;
    createdAt: string;
    reversedAt: string | null;
    reversalReason: string;
  }>;
};

export type WorkforceAdvanceOption = {
  id: string;
  dropxId: string;
  name: string;
  designation: string;
  location: string;
};

function money(value: number) {
  return `Rs ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(value: string) {
  const parts = value.slice(0, 10).split("-");
  return parts.length === 3 ? parts.reverse().join("/") : value;
}

function modeLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function responsePayload(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: `The server returned an unreadable response (HTTP ${response.status}).` }; }
}

function workforceOptionLabel(option: WorkforceAdvanceOption) {
  return [option.dropxId, option.name, option.designation, option.location].filter(Boolean).join(" · ");
}

function WorkforceSearchSelect({ onChange, options, value }: {
  onChange: (workforceId: string) => void;
  options: WorkforceAdvanceOption[];
  value: string;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOption = useMemo(() => options.find((option) => option.id === value) ?? null, [options, value]);
  const [query, setQuery] = useState(() => selectedOption ? workforceOptionLabel(selectedOption) : "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || (selectedOption && term === workforceOptionLabel(selectedOption).toLowerCase())) return options.slice(0, 100);
    return options.filter((option) => [option.dropxId, option.name, option.designation, option.location]
      .some((part) => part.toLowerCase().includes(term))).slice(0, 100);
  }, [options, query, selectedOption]);

  useEffect(() => {
    setQuery(selectedOption ? workforceOptionLabel(selectedOption) : "");
  }, [selectedOption]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function select(option: WorkforceAdvanceOption) {
    onChange(option.id);
    setQuery(workforceOptionLabel(option));
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => event.key === "ArrowDown"
        ? Math.min(current + 1, Math.max(0, visibleOptions.length - 1))
        : current <= 0 ? Math.max(0, visibleOptions.length - 1) : current - 1);
      return;
    }
    if (event.key === "Enter" && open && visibleOptions[activeIndex]) {
      event.preventDefault();
      select(visibleOptions[activeIndex]);
    }
  }

  return <div className="workforce-advance-combobox" ref={rootRef}>
    <input name="workforceId" readOnly type="hidden" value={value} />
    <input
      aria-activedescendant={open && activeIndex >= 0 && visibleOptions[activeIndex] ? `${listboxId}-${visibleOptions[activeIndex].id}` : undefined}
      aria-autocomplete="list"
      aria-controls={listboxId}
      aria-expanded={open}
      aria-required="true"
      autoComplete="off"
      className="field"
      onChange={(event) => {
        setQuery(event.target.value);
        onChange("");
        setOpen(true);
      }}
      onFocus={(event) => {
        setOpen(true);
        event.currentTarget.select();
      }}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={handleKeyDown}
      placeholder="Search DropX ID, name, designation or location"
      role="combobox"
      type="search"
      value={query}
    />
    {open ? <div aria-label="Matching Workforce" className="workforce-advance-combobox-list" id={listboxId} role="listbox">
      {visibleOptions.map((option, index) => <div
        aria-selected={option.id === value}
        className={`workforce-advance-combobox-option ${index === activeIndex ? "active" : ""}`}
        id={`${listboxId}-${option.id}`}
        key={option.id}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => select(option)}
        role="option"
      >
        <strong>{option.dropxId} — {option.name}</strong>
        <small>{[option.designation, option.location].filter(Boolean).join(" · ")}</small>
      </div>)}
      {!visibleOptions.length ? <p className="workforce-advance-combobox-empty">No matching Workforce found.</p> : null}
      {visibleOptions.length === 100 ? <p className="workforce-advance-combobox-hint">Showing the first 100 matches. Type more to narrow the list.</p> : null}
    </div> : null}
  </div>;
}

export function WorkforceAdvanceRegister({ canAdd, rows, workforceOptions }: {
  canAdd: boolean;
  rows: WorkforceAdvanceRegisterRow[];
  workforceOptions: WorkforceAdvanceOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("50");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedWorkforceId, setSelectedWorkforceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const total = useMemo(() => rows.reduce((sum, row) => sum + row.total, 0), [rows]);
  const deducted = useMemo(() => rows.reduce((sum, row) => sum + row.deducted, 0), [rows]);
  const pending = Math.max(0, total - deducted);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => (status === "all" || row.status === status) && (!term || [
      row.advanceNumber, row.dropxId, row.workforceName, row.designation, row.location, row.paidLocation,
      row.paymentReference, row.externalReference, row.remark
    ].some((value) => value.toLowerCase().includes(term))));
  }, [rows, search, status]);
  const pageSize = size === "all" ? Math.max(1, filtered.length) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  async function addAdvance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (!selectedWorkforceId) {
      setMessage({ tone: "error", text: "Select a Workforce member from the search results." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/payments/workforce-advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form.entries()))
      });
      const payload = await responsePayload(response);
      if (!response.ok) throw new Error(payload.error ?? "Unable to save the advance.");
      setMessage({ tone: "success", text: "Advance added to the register." });
      formElement.reset();
      setSelectedWorkforceId("");
      setShowAdd(false);
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to save the advance." });
    } finally {
      setBusy(false);
    }
  }

  return <div className="workforce-advance-page">
    <section aria-label="Advance totals" className="workforce-advance-totals">
      <article><span>Total advances</span><strong>{money(total)}</strong><small>{rows.length.toLocaleString("en-IN")} records</small></article>
      <article><span>Deducted</span><strong className="good-text">{money(deducted)}</strong><small>Applied through payouts</small></article>
      <article><span>Pending</span><strong className={pending > 0 ? "negative" : "good-text"}>{money(pending)}</strong><small>Balance to recover</small></article>
    </section>

    {canAdd ? <div className="workforce-advance-actions">
      <button className="button" onClick={() => setShowAdd((current) => !current)} type="button">{showAdd ? "Close entry" : "Add advance"}</button>
      <WorkforceAdvanceBulkUpload />
    </div> : null}

    {message ? <div aria-live="polite" className={`payout-inline-message ${message.tone}`}>{message.text}</div> : null}

    {canAdd && showAdd ? <section className="panel workforce-advance-entry">
      <div className="panel-head"><div><h2>Add Workforce advance</h2><p className="subtle">Record an advance that has already been paid.</p></div></div>
      <form className="workforce-advance-form" onSubmit={addAdvance}>
        <label><span>Workforce</span><WorkforceSearchSelect onChange={setSelectedWorkforceId} options={workforceOptions} value={selectedWorkforceId} /></label>
        <label><span>Advance date</span><input className="field" name="advanceDate" required type="date" /></label>
        <label><span>Amount</span><input className="field" min="0.01" name="amount" required step="0.01" type="number" /></label>
        <label><span>Payment mode</span><select className="field" name="paymentMode" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
        <label><span>Payment reference</span><input className="field" maxLength={160} name="paymentReference" /></label>
        <label><span>External reference</span><input className="field" maxLength={160} name="externalReference" /></label>
        <label className="workforce-advance-remark"><span>Remark</span><input className="field" maxLength={500} name="remark" /></label>
        <button className="button" disabled={busy} type="submit">{busy ? "Saving…" : "Save advance"}</button>
      </form>
    </section> : null}

    <section className="panel">
      <div className="panel-head workforce-advance-register-head"><div><h2>Advance register</h2><p className="subtle">Total, deducted and pending balances are calculated from recovery history.</p></div><div className="workforce-advance-filters"><label><span>Search advances</span><input className="field" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="ID, name, location or reference" type="search" value={search} /></label><label><span>Deduction status</span><select className="field" onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}><option value="all">All statuses</option><option value="Pending">Pending</option><option value="Partially deducted">Partially deducted</option><option value="Fully deducted">Fully deducted</option></select></label></div></div>
      <div className="table-wrap"><table className="workforce-advance-table"><thead><tr><th>Advance</th><th>Workforce</th><th>Designation</th><th>Location</th><th>Paid on</th><th>Payment details</th><th className="payout-money">Total</th><th className="payout-money">Deducted</th><th className="payout-money">Pending</th><th>Status</th><th>Source / remark</th></tr></thead>
        <tbody>{visible.length ? visible.map((row) => <tr key={row.id}>
          <td><strong>{row.advanceNumber}</strong></td>
          <td><strong>{row.dropxId}</strong><small>{row.workforceName}</small></td>
          <td>{row.designation || "—"}</td><td><strong>{row.location}</strong>{row.paidLocation !== row.location ? <small>Advance paid at {row.paidLocation}</small> : null}</td><td>{dateLabel(row.advanceDate)}</td>
          <td><strong>{modeLabel(row.paymentMode)}</strong><small>{row.paymentReference || row.externalReference || "No reference"}</small>{row.paymentReference && row.externalReference ? <small>{row.externalReference}</small> : null}</td>
          <td className="payout-money"><strong>{money(row.total)}</strong></td><td className="payout-money good-text">{money(row.deducted)}</td><td className="payout-money"><strong>{money(row.pending)}</strong></td>
          <td><span className={`status-pill ${row.status === "Fully deducted" ? "good" : row.status === "Partially deducted" ? "warn" : "payout-status-neutral"}`}>{row.status}</span></td>
          <td><strong>{modeLabel(row.source)}</strong><small>{row.remark || `Added ${dateLabel(row.createdAt)}`}</small>{row.recoveryHistory.length ? <details className="workforce-advance-history"><summary>Recovery history ({row.recoveryHistory.length})</summary><div>{row.recoveryHistory.map((recovery) => <p key={recovery.id}><strong>{money(recovery.amount)}</strong> · {recovery.type === "opening_balance" ? "Opening deduction" : `${dateLabel(recovery.periodStart)}–${dateLabel(recovery.periodEnd)}`}<small>{modeLabel(recovery.status)}{recovery.reversalReason ? ` · ${recovery.reversalReason}` : ""}</small></p>)}</div></details> : null}</td>
        </tr>) : <tr><td className="empty-cell" colSpan={11}>No Workforce advances match this view.</td></tr>}</tbody>
      </table></div>
      <div className="workforce-advance-pagination"><label>Rows <select className="field" onChange={(event) => { setSize(event.target.value); setPage(1); }} value={size}><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="all">All</option></select></label><span>{filtered.length ? `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length}` : "0 records"} · Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Previous</button><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))} type="button">Next</button></div>
    </section>
  </div>;
}
