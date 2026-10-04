"use client";

import { ChevronDown, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { buildWorkforcePayoutCsv } from "@/lib/workforce-payout-export";
import { matchesWorkforcePayoutFilters } from "@/lib/workforce-payout-filters";

export type WorkforcePayoutRow = {
  id: string; dropxId: string; dropxStatus: string; name: string; designation: string; providerMemberId: string; providerMemberName: string; locationId: string | null;
  location: string; provider: string; model: string; paymentMethod: string; mappingStatus: string; paymentDetailsAvailable: boolean; workDays: number; workDaysSource: string; production: number;
  paymentMethodBreakdown: Array<{ id: string; label: string; amount: number }>;
  productionBreakdown: Array<{ code: string; label: string; componentType: "production" | "amount"; count: number; rate: number; amount: number; sortOrder?: number }>;
  dailyBreakdown: Array<{
    date: string;
    workDayUnits: number;
    attendanceSource: string;
    methodAmounts: Array<{ id: string; label: string; amount: number }>;
    baseAmount: number;
    lines: Array<{ code: string; label: string; componentType: "production" | "amount"; count: number; rate: number; amount: number; sortOrder?: number }>;
  }>;
  baseAmount: number; additions: number; grossPayment: number; deductions: number; deductionBreakdown: Array<{ code: string; label: string; amount: number }>; panAadhaarStatus: "LINKED" | "NOT LINKED" | ""; netAmount: number; status: string;
};

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
function rateMoney(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function units(value: number) { return value.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function workDaysValue(value: number, source: string) { return source.toLowerCase().includes("unavailable") ? "" : value; }
function workDaysDisplay(value: number, source: string) { return workDaysValue(value, source) === "" ? "—" : units(value); }
function statusTone(status: string) {
  if (status === "Ready for review") return "good";
  if (status === "ID not mapped" || status === "Mapping conflict") return "bad";
  if (status === "Configuration incomplete" || status === "Payment method not allocated") return "warn";
  return "payout-status-neutral";
}

function PayoutMultiFilter({ allLabel, label, onChange, options, selected }: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: string[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.toLowerCase().includes(term));
  }, [options, query]);
  const summary = selected.length === 0
    ? allLabel
    : selected.length <= 2
      ? selected.join(", ")
      : `${selected.length} selected`;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
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

  return <div className="payout-multi-filter" ref={rootRef}>
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
      {open ? <div aria-label={`${label} options`} className="multi-select-menu payout-filter-menu" role="dialog">
        <div className="multi-select-search payout-filter-search">
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
          {visibleOptions.map((option) => <label className={`multi-select-option ${selectedSet.has(option) ? "selected" : ""}`} key={option}>
            <input checked={selectedSet.has(option)} onChange={() => toggle(option)} type="checkbox" />
            <span>{option}</span>
          </label>)}
          {!visibleOptions.length ? <p className="payout-filter-empty">No matching options</p> : null}
        </div>
      </div> : null}
    </div>
  </div>;
}

export function WorkforcePayoutTable({ audience = "workforce", rows }: { audience?: "workforce" | "helpers"; rows: WorkforcePayoutRow[] }) {
  const subjectLabel = audience === "helpers" ? "Helper" : "Workforce";
  const subjectLabelLower = subjectLabel.toLowerCase();
  const [search, setSearch] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [methods, setMethods] = useState<string[]>([]);
  const [mappingStatuses, setMappingStatuses] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("50");
  const [expandedId, setExpandedId] = useState("");
  const [stickyScrollWidth, setStickyScrollWidth] = useState(0);
  const [stickyScrollFrame, setStickyScrollFrame] = useState({ left: 0, width: 0, visible: false });
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const stickyScrollRef = useRef<HTMLDivElement>(null);
  const deferredSearch = useDeferredValue(search);
  const locationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.location || "-")).values()).sort(), [rows]);
  const designationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.designation).filter(Boolean))).sort((left, right) => left.localeCompare(right)), [rows]);
  const providerOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.provider || "-")).values()).sort(), [rows]);
  const mappingStatusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.mappingStatus).filter(Boolean))).sort(), [rows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status || "-")).values()).sort(), [rows]);
  const methodOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.paymentMethodBreakdown.map((item) => item.label)))).sort((left, right) => left.localeCompare(right)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => matchesWorkforcePayoutFilters(row, deferredSearch, { locations, designations, providers, methods, mappingStatuses, statuses })), [rows, deferredSearch, locations, designations, providers, methods, mappingStatuses, statuses]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const activeFilterCount = locations.length + designations.length + providers.length + methods.length + mappingStatuses.length + statuses.length;
  const tableColumnCount = 12;

  useEffect(() => {
    const tableWrap = tableWrapRef.current;
    const stickyScroll = stickyScrollRef.current;
    if (!tableWrap || !stickyScroll) return;
    const tableWrapElement: HTMLDivElement = tableWrap;
    const stickyScrollElement: HTMLDivElement = stickyScroll;

    let syncing = false;
    function syncFromTable() {
      if (syncing) return;
      syncing = true;
      stickyScrollElement.scrollLeft = tableWrapElement.scrollLeft;
      syncing = false;
    }
    function syncFromSticky() {
      if (syncing) return;
      syncing = true;
      tableWrapElement.scrollLeft = stickyScrollElement.scrollLeft;
      syncing = false;
    }
    function updateStickyScroll() {
      const rect = tableWrapElement.getBoundingClientRect();
      const hasOverflow = tableWrapElement.scrollWidth > tableWrapElement.clientWidth + 1;
      setStickyScrollWidth(tableWrapElement.scrollWidth);
      setStickyScrollFrame({
        left: Math.max(0, rect.left),
        width: Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)),
        visible: hasOverflow && rect.top < window.innerHeight - 20 && rect.bottom > 28
      });
      syncFromTable();
    }

    tableWrapElement.addEventListener("scroll", syncFromTable, { passive: true });
    stickyScrollElement.addEventListener("scroll", syncFromSticky, { passive: true });
    window.addEventListener("scroll", updateStickyScroll, { passive: true });
    window.addEventListener("resize", updateStickyScroll);
    const resizeObserver = new ResizeObserver(updateStickyScroll);
    resizeObserver.observe(tableWrapElement);
    const table = tableWrapElement.querySelector("table");
    if (table) resizeObserver.observe(table);
    updateStickyScroll();
    return () => {
      tableWrapElement.removeEventListener("scroll", syncFromTable);
      stickyScrollElement.removeEventListener("scroll", syncFromSticky);
      window.removeEventListener("scroll", updateStickyScroll);
      window.removeEventListener("resize", updateStickyScroll);
      resizeObserver.disconnect();
    };
  }, [expandedId, filtered.length, safePage, visible.length]);

  function clearFilters() {
    setLocations([]); setDesignations([]); setProviders([]); setMethods([]); setMappingStatuses([]); setStatuses([]); setPage(1);
  }

  function toggleBreakup(rowId: string, button: HTMLButtonElement) {
    const opening = expandedId !== rowId;
    setExpandedId(opening ? rowId : "");
    const scrollArea = button.closest<HTMLElement>(".payout-table-wrap");
    if (opening && scrollArea?.scrollLeft) requestAnimationFrame(() => scrollArea.scrollTo({ left: 0, behavior: "smooth" }));
  }

  function exportRows() {
    const exportableRows = rows.filter((row) => matchesWorkforcePayoutFilters(row, search, { locations, designations, providers, methods, mappingStatuses, statuses }));
    const csv = buildWorkforcePayoutCsv(exportableRows, subjectLabel);
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `${audience}-payouts.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  return <>
    <div className="payout-search-strip">
      <label>
        <span className="payout-toolbar-label">Search {subjectLabelLower}</span>
        <input className="field" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={audience === "helpers" ? "DropX ID, helper, designation or location" : "DropX ID, worker, designation or provider ID"} />
      </label>
      <div className="payout-search-controls">
        <span aria-live="polite" className="payout-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
        <button className="button secondary" type="button" onClick={exportRows}>Export full CSV</button>
      </div>
    </div>
    <div aria-label="Payout filters" className="payout-filter-panel" id="payout-filter-panel">
      <PayoutMultiFilter allLabel="All allocated locations" label="Location" onChange={(values) => { setLocations(values); setPage(1); }} options={locationOptions} selected={locations} />
      <PayoutMultiFilter allLabel="All designations" label="Designation" onChange={(values) => { setDesignations(values); setPage(1); }} options={designationOptions} selected={designations} />
      <PayoutMultiFilter allLabel="All providers" label="Provider" onChange={(values) => { setProviders(values); setPage(1); }} options={providerOptions} selected={providers} />
      <PayoutMultiFilter allLabel="All methods" label="Payment method" onChange={(values) => { setMethods(values); setPage(1); }} options={methodOptions} selected={methods} />
      <PayoutMultiFilter allLabel="All mapping statuses" label="Mapping status" onChange={(values) => { setMappingStatuses(values); setPage(1); }} options={mappingStatusOptions} selected={mappingStatuses} />
      <PayoutMultiFilter allLabel="All statuses" label="Status" onChange={(values) => { setStatuses(values); setPage(1); }} options={statusOptions} selected={statuses} />
      <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
    </div>
    <div className="table-wrap payout-table-wrap" ref={tableWrapRef}>
      <table className="workforce-payout-table workforce-payout-detail-table payout-view-overview">
        <caption className="sr-only">{subjectLabel} payout totals</caption>
        <thead><tr>
          <th className="payout-sticky-id" scope="col">DropX ID</th>
          <th className="payout-sticky-worker" scope="col">{subjectLabel} / payment source</th>
          <th scope="col">Designation</th>
          <th scope="col">Location</th>
          <th scope="col">Allocation</th>
          <th scope="col">Payment Method</th>
          <th className="work-days-group" scope="col">Work Days</th>
          <th className="payout-money" scope="col">Gross Payment</th>
          <th className="payout-money" scope="col">Gross Deductions</th>
          <th className="payout-money" scope="col">Net Pay</th>
          <th scope="col">Status</th>
          <th scope="col">Details</th>
        </tr></thead>
        <tbody>
          {visible.length ? visible.flatMap((row) => {
            const expanded = expandedId === row.id;
            const detailId = `payout-breakup-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const paymentTotals = row.productionBreakdown.filter((item) => item.amount !== 0);
            const deductionTotals = row.deductionBreakdown.filter((item) => item.amount !== 0);
            return [
              <tr key={row.id} className={row.mappingStatus === "ID not mapped" || row.mappingStatus === "Mapping conflict" ? "payout-id-unmapped" : row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}>
                <td className="payout-sticky-id">{row.dropxId ? <><strong>{row.dropxId}</strong><small className="payout-dropx-status" title={`DropX ID status: ${row.dropxStatus}`}>{row.dropxStatus}</small></> : <span className="sr-only">No DropX ID mapped</span>}</td>
                <td className="payout-sticky-worker"><strong>{row.name}</strong><small title={`${row.providerMemberName} · ${row.providerMemberId}`}>{row.providerMemberName} · {row.providerMemberId}</small></td>
                <td>{row.designation ? <strong>{row.designation}</strong> : <span aria-hidden="true">—</span>}</td>
                <td><strong>{row.location}</strong></td>
                <td><strong>{row.provider}</strong><small>{row.model}</small></td>
                <td>{row.paymentDetailsAvailable ? <strong>{row.paymentMethod}</strong> : <span className="sr-only">Payment method unavailable</span>}</td>
                <td className="work-days-cell">{row.paymentDetailsAvailable ? <><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></> : null}</td>
                <td className="payout-money">{row.paymentDetailsAvailable ? <strong>{money(row.grossPayment)}</strong> : null}</td>
                <td className="negative payout-money">{row.paymentDetailsAvailable ? row.deductions ? `- ${money(row.deductions)}` : "—" : null}</td>
                <td className="payout-money payout-net-pay">{row.paymentDetailsAvailable ? <strong>{money(row.netAmount)}</strong> : null}</td>
                <td><div className="payout-status-stack"><span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span>{row.paymentDetailsAvailable && row.panAadhaarStatus ? <span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus === "LINKED" ? "PAN linked" : "PAN not linked"}</span> : null}</div></td>
                <td>{row.paymentDetailsAvailable ? <button aria-controls={detailId} aria-expanded={expanded} className="button secondary compact" onClick={(event) => toggleBreakup(row.id, event.currentTarget)} type="button">{expanded ? "Close" : "Breakup"}</button> : <span className="sr-only">No payment breakup until mapping and payment setup are complete</span>}</td>
              </tr>,
              expanded ? <tr className="payout-total-detail-row" key={`${row.id}-totals`}>
                <td colSpan={tableColumnCount}>
                  <section className="payout-total-detail" id={detailId}>
                    <header>
                      <span><small>DropX associate</small><strong>{row.name}</strong></span>
                      <span><small>Partner ID</small><strong>{row.providerMemberId}</strong></span>
                      <span><small>Partner name</small><strong>{row.providerMemberName}</strong></span>
                    </header>
                    <div className="payout-breakup-summary">
                      <span><small>Gross payment</small><strong>{money(row.grossPayment)}</strong></span>
                      <span><small>Gross deductions</small><strong className={row.deductions ? "negative" : undefined}>{row.deductions ? `- ${money(row.deductions)}` : money(0)}</strong></span>
                      <span><small>Net pay</small><strong>{money(row.netAmount)}</strong></span>
                    </div>
                    <div className="payout-total-groups">
                      <section className="payout-total-group">
                        <h3>Payment totals</h3>
                        <div className="table-wrap payout-total-table-wrap">
                          <table>
                            <caption className="sr-only">Payment-head totals for {row.name}</caption>
                            <thead><tr><th scope="col">Payment</th><th className="payout-money" scope="col">Units</th><th className="payout-money" scope="col">Rate</th><th className="payout-money" scope="col">Total</th></tr></thead>
                            <tbody>
                              {paymentTotals.map((item) => <tr key={item.code}><td><strong>{item.label}</strong></td><td className="payout-money">{units(item.count)}</td><td className="payout-money">{rateMoney(item.rate)}</td><td className="payout-money"><strong>{money(item.amount)}</strong></td></tr>)}
                              {row.additions ? <tr><td><strong>Additional payments</strong></td><td className="payout-money">—</td><td className="payout-money">—</td><td className="positive payout-money"><strong>+ {money(row.additions)}</strong></td></tr> : null}
                              {!paymentTotals.length && !row.additions ? <tr><td className="empty-cell" colSpan={4}>No payment amount for this period.</td></tr> : null}
                            </tbody>
                            <tfoot><tr><th colSpan={3} scope="row">Gross payment</th><td className="payout-money"><strong>{money(row.grossPayment)}</strong></td></tr></tfoot>
                          </table>
                        </div>
                      </section>
                      <section className="payout-total-group">
                        <h3>Deduction totals</h3>
                        <div className="table-wrap payout-total-table-wrap">
                          <table>
                            <caption className="sr-only">Deduction-head totals for {row.name}</caption>
                            <thead><tr><th scope="col">Deduction</th><th className="payout-money" scope="col">Total</th></tr></thead>
                            <tbody>
                              {deductionTotals.map((item) => <tr key={item.code}><td><strong>{item.label}</strong></td><td className="negative payout-money"><strong>- {money(item.amount)}</strong></td></tr>)}
                              {!deductionTotals.length ? <tr><td className="empty-cell" colSpan={2}>No deductions for this period.</td></tr> : null}
                            </tbody>
                            <tfoot><tr><th scope="row">Gross deductions</th><td className={`${row.deductions ? "negative " : ""}payout-money`}><strong>{row.deductions ? `- ${money(row.deductions)}` : money(0)}</strong></td></tr></tfoot>
                          </table>
                        </div>
                      </section>
                    </div>
                  </section>
                </td>
              </tr> : null
            ].filter(Boolean) as ReactElement[];
          }) : <tr><td className="empty-cell" colSpan={tableColumnCount}>No {subjectLabelLower} payouts match the selected period and filters.</td></tr>}
        </tbody>
      </table>
    </div>
    <div
      aria-label={`${subjectLabel} payout horizontal scrollbar`}
      className={`payout-sticky-scroll ${stickyScrollFrame.visible ? "visible" : ""}`}
      ref={stickyScrollRef}
      role="region"
      style={{ left: stickyScrollFrame.left, width: stickyScrollFrame.width }}
      tabIndex={stickyScrollFrame.visible ? 0 : -1}
    >
      <div style={{ width: stickyScrollWidth }} />
    </div>
    <div className="pagination payout-pagination">
      <label className="payout-page-size">Rows per page<select className="field" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}>{["50","100","500","1000","all"].map((value) => <option value={value} key={value}>{value === "all" ? "All" : value}</option>)}</select></label>
      <span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span>
      <div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} type="button">Next</button></div>
    </div>
  </>;
}
