"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { WorkforceAdvanceBulkUpload } from "@/components/workforce-advance-bulk-upload";
import {
  buildWorkforceAdvanceCsv,
  filterWorkforceAdvanceRows,
  summarizeWorkforceAdvanceRows,
  workforceAdvanceExportFilename,
  workforceAdvanceFacetValues
} from "@/lib/workforce-advance-register-view";

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
  status: "Awaiting Workforce registration" | "Pending" | "Partially deducted" | "Fully deducted";
  linkStatus: "pending" | "linked";
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

type AdvanceFilterOption = {
  label: string;
  value: string;
};

function advanceFilterOptions(values: string[], label: (value: string) => string = (value) => value) {
  return values.map((value) => ({ value, label: label(value) }));
}

function unavailableAdvanceFilterLabel(value: string) {
  return value === "—" ? "Unassigned / unavailable" : value;
}

function AdvanceMultiFilter({ allLabel, label, onChange, options, selected }: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: AdvanceFilterOption[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const labelsByValue = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.label} ${option.value}`.toLowerCase().includes(term));
  }, [options, query]);
  const selectedLabels = selected.map((value) => labelsByValue.get(value) ?? value);
  const summary = selectedLabels.length === 0
    ? allLabel
    : selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels.length} selected`;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle(value: string) {
    onChange(selectedSet.has(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value]);
  }

  return <div className="workforce-advance-multi-filter" ref={rootRef}>
    <span>{label}</span>
    <div className="multi-select">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${summary}`}
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="multi-select-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={15} />
      </button>
      {open ? <div aria-label={`${label} options`} className="multi-select-menu workforce-advance-filter-menu" role="dialog">
        <div className="multi-select-search workforce-advance-filter-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label={`Search ${label.toLowerCase()}`}
            autoFocus
            className="field multi-select-search-field"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${label.toLowerCase()}`}
            type="search"
            value={query}
          />
        </div>
        <label className="multi-select-all">
          <input checked={selected.length === 0} onChange={() => onChange([])} type="checkbox" />
          <span>{allLabel}</span>
        </label>
        <div aria-label={label} className="multi-select-options" role="group">
          {visibleOptions.map((option) => <label className={`multi-select-option ${selectedSet.has(option.value) ? "selected" : ""}`} key={option.value}>
            <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
            <span>{option.label}</span>
          </label>)}
          {!visibleOptions.length ? <p className="workforce-advance-filter-empty">No matching options</p> : null}
        </div>
      </div> : null}
    </div>
  </div>;
}

export function WorkforceAdvanceRegister({ canAdd, rows, workforceOptions }: {
  canAdd: boolean;
  rows: WorkforceAdvanceRegisterRow[];
  workforceOptions: WorkforceAdvanceOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [paidLocations, setPaidLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [paymentModes, setPaymentModes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [registrationStatuses, setRegistrationStatuses] = useState<Array<WorkforceAdvanceRegisterRow["linkStatus"]>>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("50");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedWorkforceId, setSelectedWorkforceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const locationOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "location"), unavailableAdvanceFilterLabel), [rows]);
  const paidLocationOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "paidLocation"), unavailableAdvanceFilterLabel), [rows]);
  const designationOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "designation"), unavailableAdvanceFilterLabel), [rows]);
  const paymentModeOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "paymentMode"), modeLabel), [rows]);
  const statusOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "status")), [rows]);
  const sourceOptions = useMemo(() => advanceFilterOptions(workforceAdvanceFacetValues(rows, "source"), modeLabel), [rows]);
  const registrationOptions = useMemo(() => {
    const available = new Set(workforceAdvanceFacetValues(rows, "registrationStatus"));
    return [
      { value: "linked", label: "Linked" },
      { value: "pending", label: "Awaiting registration" }
    ].filter((option) => available.has(option.value));
  }, [rows]);
  const filters = useMemo(() => ({
    designations,
    locations,
    paidLocations,
    paymentModes,
    statuses,
    sources,
    registrationStatuses,
    dateFrom,
    dateTo
  }), [designations, locations, paidLocations, paymentModes, statuses, sources, registrationStatuses, dateFrom, dateTo]);
  const filtered = useMemo(() => filterWorkforceAdvanceRows(rows, search, filters), [rows, search, filters]);
  const summary = useMemo(() => summarizeWorkforceAdvanceRows(filtered), [filtered]);
  const invalidDateRange = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const activeFilterCount = (search.trim() ? 1 : 0)
    + locations.length + paidLocations.length + designations.length + paymentModes.length
    + statuses.length + sources.length + registrationStatuses.length
    + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);
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

  function clearFilters() {
    setSearch("");
    setLocations([]);
    setPaidLocations([]);
    setDesignations([]);
    setPaymentModes([]);
    setStatuses([]);
    setSources([]);
    setRegistrationStatuses([]);
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  function exportRows() {
    if (!filtered.length || invalidDateRange) return;
    const csv = buildWorkforceAdvanceCsv(filtered);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = workforceAdvanceExportFilename(dateFrom, dateTo);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="workforce-advance-page">
    <section aria-label="Advance totals" className="workforce-advance-totals">
      <article><span>Total advances</span><strong>{money(summary.total)}</strong><small>{activeFilterCount ? `${summary.records.toLocaleString("en-IN")} of ${rows.length.toLocaleString("en-IN")} records` : `${summary.records.toLocaleString("en-IN")} records`}{summary.awaitingRegistration ? ` · ${summary.awaitingRegistration.toLocaleString("en-IN")} awaiting registration` : ""}</small></article>
      <article><span>Deducted</span><strong className="good-text">{money(summary.deducted)}</strong><small>Already recovered or deducted through payouts</small></article>
      <article><span>Pending</span><strong className={summary.pending > 0 ? "negative" : "good-text"}>{money(summary.pending)}</strong><small>Balance to recover, including unregistered IDs</small></article>
    </section>

    <div className="workforce-advance-actions">
      {canAdd ? <>
        <button className="button" onClick={() => setShowAdd((current) => !current)} type="button">{showAdd ? "Close entry" : "Add advance"}</button>
        <WorkforceAdvanceBulkUpload />
      </> : null}
      <button className="button secondary" disabled={!filtered.length || invalidDateRange} onClick={exportRows} type="button">Export filtered CSV ({filtered.length.toLocaleString("en-IN")})</button>
    </div>

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
      <div className="panel-head workforce-advance-register-head">
        <div><h2>Advance register</h2><p className="subtle">Unregistered DropX IDs remain in these totals but cannot be deducted from payouts until Workforce registration links them.</p></div>
        <span aria-live="polite" className="workforce-advance-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
      </div>
      <div aria-label="Advance register filters" className="workforce-advance-filter-panel">
        <label className="workforce-advance-filter-field workforce-advance-search-filter"><span>Search advances</span><input className="field" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="ID, name, location or reference" type="search" value={search} /></label>
        <AdvanceMultiFilter allLabel="All current locations" label="Current location" onChange={(values) => { setLocations(values); setPage(1); }} options={locationOptions} selected={locations} />
        <AdvanceMultiFilter allLabel="All paid locations" label="Advance paid at" onChange={(values) => { setPaidLocations(values); setPage(1); }} options={paidLocationOptions} selected={paidLocations} />
        <AdvanceMultiFilter allLabel="All designations" label="Designation" onChange={(values) => { setDesignations(values); setPage(1); }} options={designationOptions} selected={designations} />
        <AdvanceMultiFilter allLabel="All payment modes" label="Payment mode" onChange={(values) => { setPaymentModes(values); setPage(1); }} options={paymentModeOptions} selected={paymentModes} />
        <AdvanceMultiFilter allLabel="All deduction statuses" label="Deduction status" onChange={(values) => { setStatuses(values); setPage(1); }} options={statusOptions} selected={statuses} />
        <AdvanceMultiFilter allLabel="All registration statuses" label="Registration status" onChange={(values) => { setRegistrationStatuses(values.filter((value): value is WorkforceAdvanceRegisterRow["linkStatus"] => value === "linked" || value === "pending")); setPage(1); }} options={registrationOptions} selected={registrationStatuses} />
        <AdvanceMultiFilter allLabel="All sources" label="Source" onChange={(values) => { setSources(values); setPage(1); }} options={sourceOptions} selected={sources} />
        <label className="workforce-advance-filter-field"><span>Paid from</span><input className="field" max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} type="date" value={dateFrom} /></label>
        <label className="workforce-advance-filter-field"><span>Paid to</span><input className="field" min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} type="date" value={dateTo} /></label>
        <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
      </div>
      {invalidDateRange ? <div aria-live="polite" className="payout-inline-message error">Paid from date must be on or before paid to date.</div> : null}
      <div className="table-wrap"><table className="workforce-advance-table"><thead><tr><th>Advance</th><th>Workforce</th><th>Designation</th><th>Location</th><th>Paid on</th><th>Payment details</th><th className="payout-money">Total</th><th className="payout-money">Deducted</th><th className="payout-money">Pending</th><th>Status</th><th>Source / remark</th></tr></thead>
        <tbody>{visible.length ? visible.map((row) => <tr className={row.linkStatus === "pending" ? "workforce-advance-pending-row" : undefined} key={row.id}>
          <td><strong>{row.advanceNumber}</strong></td>
          <td><strong>{row.dropxId}</strong><small>{row.workforceName}</small></td>
          <td>{row.designation || "—"}</td><td><strong>{row.location}</strong>{row.linkStatus === "linked" && row.paidLocation !== row.location ? <small>Advance paid at {row.paidLocation}</small> : null}</td><td>{dateLabel(row.advanceDate)}</td>
          <td><strong>{modeLabel(row.paymentMode)}</strong><small>{row.paymentReference || row.externalReference || "No reference"}</small>{row.paymentReference && row.externalReference ? <small>{row.externalReference}</small> : null}</td>
          <td className="payout-money"><strong>{money(row.total)}</strong></td><td className="payout-money good-text">{money(row.deducted)}</td><td className="payout-money"><strong>{money(row.pending)}</strong></td>
          <td><span className={`status-pill ${row.status === "Fully deducted" ? "good" : row.status === "Partially deducted" || row.status === "Awaiting Workforce registration" ? "warn" : "payout-status-neutral"}`}>{row.status}</span>{row.linkStatus === "pending" ? <small>Not eligible for payout deduction</small> : null}</td>
          <td><strong>{modeLabel(row.source)}</strong><small>{row.remark || `Added ${dateLabel(row.createdAt)}`}</small>{row.linkStatus === "pending" ? <small>Links automatically when this exact DropX ID is registered.</small> : null}{row.recoveryHistory.length ? <details className="workforce-advance-history"><summary>Recovery history ({row.recoveryHistory.length})</summary><div>{row.recoveryHistory.map((recovery) => <p key={recovery.id}><strong>{money(recovery.amount)}</strong> · {recovery.type === "opening_balance" ? "Opening deduction" : `${dateLabel(recovery.periodStart)}–${dateLabel(recovery.periodEnd)}`}<small>{modeLabel(recovery.status)}{recovery.reversalReason ? ` · ${recovery.reversalReason}` : ""}</small></p>)}</div></details> : null}</td>
        </tr>) : <tr><td className="empty-cell" colSpan={11}>No Workforce advances match this view.</td></tr>}</tbody>
      </table></div>
      <div className="workforce-advance-pagination"><label>Rows <select className="field" onChange={(event) => { setSize(event.target.value); setPage(1); }} value={size}><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="all">All</option></select></label><span>{filtered.length ? `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length}` : "0 records"} · Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Previous</button><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))} type="button">Next</button></div>
    </section>
  </div>;
}
