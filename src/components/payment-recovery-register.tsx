"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PaymentRecoveryBulkUpload } from "@/components/payment-recovery-bulk-upload";

export type PaymentRecoveryAllocation = {
  id: string;
  dropxId: string;
  targetType: string;
  personName: string;
  category: string;
  location: string;
  amount: number;
  linkStatus: "linked" | "pending";
};

export type PaymentRecoveryRegisterRow = {
  id: string;
  tid: string;
  providerCode: string;
  providerName: string;
  location: string;
  debitDate: string;
  debitAmount: number;
  recoveredAmount: number;
  pendingAmount: number;
  recoveryMethod: "payout_deduction" | "post_invoice_dispute";
  status:
    | "awaiting_registration"
    | "ready_for_deduction"
    | "planned_provider_dispute"
    | "partially_recovered"
    | "recovered"
    | "under_provider_dispute"
    | "provider_credited"
    | "dispute_rejected"
    | "reversed";
  providerReference: string;
  reason: string;
  remark: string;
  source: string;
  createdAt: string;
  allocations: PaymentRecoveryAllocation[];
};

type FilterOption = { value: string; label: string };

const routeLabels: Record<PaymentRecoveryRegisterRow["recoveryMethod"], string> = {
  payout_deduction: "Payout deduction",
  post_invoice_dispute: "Post-invoice provider dispute"
};

const statusLabels: Record<PaymentRecoveryRegisterRow["status"], string> = {
  awaiting_registration: "Awaiting registration",
  ready_for_deduction: "Ready for deduction",
  planned_provider_dispute: "Provider dispute planned",
  partially_recovered: "Partially recovered",
  recovered: "Recovered",
  under_provider_dispute: "Under provider dispute",
  provider_credited: "Provider credited",
  dispute_rejected: "Dispute rejected",
  reversed: "Reversed"
};

function money(value: number) {
  return `Rs ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(value: string) {
  const parts = value.slice(0, 10).split("-");
  return parts.length === 3 ? parts.reverse().join("/") : value;
}

function sentenceLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function uniqueOptions(values: string[], label: (value: string) => string = (value) => value): FilterOption[] {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => label(left).localeCompare(label(right)))
    .map((value) => ({ value, label: label(value) }));
}

function rowLinkStatus(row: PaymentRecoveryRegisterRow) {
  if (row.recoveryMethod === "post_invoice_dispute") return "not_applicable";
  return row.allocations.some((allocation) => allocation.linkStatus === "pending") ? "pending" : "linked";
}

function rowCategories(row: PaymentRecoveryRegisterRow) {
  return row.allocations.length
    ? [...new Set(row.allocations.map((allocation) => allocation.category))]
    : ["Provider dispute"];
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  const spreadsheetSafe = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

function RecoveryMultiFilter({ allLabel, label, onChange, options, selected }: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: FilterOption[];
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

export function PaymentRecoveryRegister({ canAdd, rows }: {
  canAdd: boolean;
  rows: PaymentRecoveryRegisterRow[];
}) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("50");

  const providerOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of rows) {
      labels.set(row.providerCode, row.providerName && row.providerName !== row.providerCode
        ? `${row.providerCode} — ${row.providerName}`
        : row.providerCode);
    }
    return uniqueOptions([...labels.keys()], (code) => labels.get(code) ?? code);
  }, [rows]);
  const locationOptions = useMemo(() => uniqueOptions(rows.map((row) => row.location)), [rows]);
  const categoryOptions = useMemo(() => uniqueOptions(rows.flatMap(rowCategories)), [rows]);
  const routeOptions = useMemo(() => uniqueOptions(rows.map((row) => row.recoveryMethod), (value) => routeLabels[value as PaymentRecoveryRegisterRow["recoveryMethod"]] ?? sentenceLabel(value)), [rows]);
  const statusOptions = useMemo(() => uniqueOptions(rows.map((row) => row.status), (value) => statusLabels[value as PaymentRecoveryRegisterRow["status"]] ?? sentenceLabel(value)), [rows]);
  const linkOptions = useMemo(() => uniqueOptions(rows.map(rowLinkStatus), (value) => value === "linked" ? "Linked" : value === "pending" ? "Awaiting registration" : "Not applicable"), [rows]);
  const invalidDateRange = Boolean(dateFrom && dateTo && dateFrom > dateTo);

  const filtered = useMemo(() => {
    if (invalidDateRange) return [];
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (dateFrom && row.debitDate.slice(0, 10) < dateFrom) return false;
      if (dateTo && row.debitDate.slice(0, 10) > dateTo) return false;
      if (providers.length && !providers.includes(row.providerCode)) return false;
      if (locations.length && !locations.includes(row.location)) return false;
      if (categories.length && !rowCategories(row).some((category) => categories.includes(category))) return false;
      if (routes.length && !routes.includes(row.recoveryMethod)) return false;
      if (statuses.length && !statuses.includes(row.status)) return false;
      if (links.length && !links.includes(rowLinkStatus(row))) return false;
      if (!term) return true;
      const searchable = [
        row.tid,
        row.providerCode,
        row.providerName,
        row.location,
        row.providerReference,
        row.reason,
        row.remark,
        ...row.allocations.flatMap((allocation) => [allocation.dropxId, allocation.personName, allocation.category, allocation.location])
      ];
      return searchable.some((value) => value.toLowerCase().includes(term));
    });
  }, [categories, dateFrom, dateTo, invalidDateRange, links, locations, providers, routes, rows, search, statuses]);

  const totals = useMemo(() => filtered.reduce((summary, row) => {
    summary.debit += row.debitAmount;
    summary.recovered += row.recoveredAmount;
    if (row.status === "under_provider_dispute") summary.dispute += row.pendingAmount;
    else summary.pending += row.pendingAmount;
    return summary;
  }, { debit: 0, recovered: 0, dispute: 0, pending: 0 }), [filtered]);
  const activeFilterCount = (search.trim() ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0)
    + providers.length + locations.length + categories.length + routes.length + statuses.length + links.length;
  const pageSize = size === "all" ? Math.max(1, filtered.length) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = size === "all" ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function clearFilters() {
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setProviders([]);
    setLocations([]);
    setCategories([]);
    setRoutes([]);
    setStatuses([]);
    setLinks([]);
    setPage(1);
  }

  function exportRows() {
    if (!filtered.length || invalidDateRange) return;
    const headings = ["TID", "PROVIDER", "LOCATION", "DEBIT_DATE", "DEBIT_AMOUNT", "RECOVERY_ROUTE", "RECOVERY_IDS", "CATEGORIES", "RECOVERED", "UNDER_DISPUTE", "PENDING", "STATUS", "LINK_STATUS", "PROVIDER_REFERENCE", "REASON", "REMARK"];
    const csv = [headings, ...filtered.map((row) => [
      row.tid,
      row.providerCode,
      row.location,
      row.debitDate.slice(0, 10),
      row.debitAmount.toFixed(2),
      routeLabels[row.recoveryMethod],
      row.allocations.map((allocation) => allocation.dropxId).join(", "),
      rowCategories(row).join(", "),
      row.recoveredAmount.toFixed(2),
      row.status === "under_provider_dispute" ? row.pendingAmount.toFixed(2) : "0.00",
      row.status === "under_provider_dispute" ? "0.00" : row.pendingAmount.toFixed(2),
      statusLabels[row.status],
      rowLinkStatus(row),
      row.providerReference,
      row.reason,
      row.remark
    ])].map((record) => record.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `payment-recoveries-${dateFrom || "all"}-to-${dateTo || "all"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="workforce-advance-page">
    <section aria-label="Filtered recovery totals" className="summary-grid">
      <article className="metric-card"><span>Total provider debit</span><strong>{money(totals.debit)}</strong><small>{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "TID" : "TIDs"}</small></article>
      <article className="metric-card"><span>Recovered</span><strong className="good-text">{money(totals.recovered)}</strong><small>Posted recoveries and provider credits</small></article>
      <article className="metric-card"><span>Under dispute</span><strong>{money(totals.dispute)}</strong><small>Outstanding with the provider after submission</small></article>
      <article className="metric-card"><span>Pending</span><strong className={totals.pending > 0 ? "negative" : "good-text"}>{money(totals.pending)}</strong><small>Awaiting payout recovery or dispute submission</small></article>
    </section>

    <div className="workforce-advance-actions">
      {canAdd ? <PaymentRecoveryBulkUpload /> : null}
      <button className="button secondary" disabled={!filtered.length || invalidDateRange} onClick={exportRows} type="button">Export filtered CSV ({filtered.length.toLocaleString("en-IN")})</button>
    </div>

    <section className="panel">
      <div className="panel-head workforce-advance-register-head">
        <div><h2>Recovery register</h2><p className="subtle">One row per provider-debited TID. Expand an allocation to see the equal split across People IDs.</p></div>
        <span aria-live="polite" className="workforce-advance-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
      </div>
      <div aria-label="Recovery register filters" className="workforce-advance-filter-panel">
        <label className="workforce-advance-filter-field workforce-advance-search-filter"><span>Search recoveries</span><input className="field" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="TID, DropX ID, person or reference" type="search" value={search} /></label>
        <label className="workforce-advance-filter-field"><span>Debited from</span><input className="field" max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} type="date" value={dateFrom} /></label>
        <label className="workforce-advance-filter-field"><span>Debited to</span><input className="field" min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} type="date" value={dateTo} /></label>
        <RecoveryMultiFilter allLabel="All providers" label="Provider" onChange={(values) => { setProviders(values); setPage(1); }} options={providerOptions} selected={providers} />
        <RecoveryMultiFilter allLabel="All locations" label="Location" onChange={(values) => { setLocations(values); setPage(1); }} options={locationOptions} selected={locations} />
        <RecoveryMultiFilter allLabel="All categories" label="People category" onChange={(values) => { setCategories(values); setPage(1); }} options={categoryOptions} selected={categories} />
        <RecoveryMultiFilter allLabel="All routes" label="Recovery route" onChange={(values) => { setRoutes(values); setPage(1); }} options={routeOptions} selected={routes} />
        <RecoveryMultiFilter allLabel="All statuses" label="Status" onChange={(values) => { setStatuses(values); setPage(1); }} options={statusOptions} selected={statuses} />
        <RecoveryMultiFilter allLabel="All link statuses" label="ID link" onChange={(values) => { setLinks(values); setPage(1); }} options={linkOptions} selected={links} />
        <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
      </div>
      {invalidDateRange ? <div aria-live="polite" className="payout-inline-message error">Debited from date must be on or before debited to date.</div> : null}
      <div className="table-wrap workforce-advance-table-wrap"><table className="workforce-advance-table"><thead><tr><th>TID</th><th>Provider</th><th>Location</th><th>Debited on</th><th className="payout-money">Provider debit</th><th>Recovery route</th><th>Recover from</th><th className="payout-money">Recovered</th><th className="payout-money">Pending</th><th>Status</th><th>Reference / reason</th></tr></thead>
        <tbody>{visible.length ? visible.map((row) => {
          const linkStatus = rowLinkStatus(row);
          return <tr className={linkStatus === "pending" ? "workforce-advance-pending-row" : undefined} key={row.id}>
            <td><strong>{row.tid}</strong><small>Added {dateLabel(row.createdAt)}</small></td>
            <td><strong>{row.providerCode}</strong><small>{row.providerName || row.providerCode}</small></td>
            <td><strong>{row.location}</strong></td>
            <td>{dateLabel(row.debitDate)}</td>
            <td className="payout-money"><strong>{money(row.debitAmount)}</strong></td>
            <td><strong>{routeLabels[row.recoveryMethod]}</strong><small>{row.recoveryMethod === "payout_deduction" ? "Planned for People payment" : "Planned against provider invoice"}</small></td>
            <td>{row.allocations.length ? <details className="workforce-advance-history"><summary>{row.allocations.length} {row.allocations.length === 1 ? "ID" : "IDs"} · equal allocation</summary><div>{row.allocations.map((allocation) => <p key={allocation.id}><strong>{allocation.dropxId} · {money(allocation.amount)}</strong><small>{allocation.personName} · {allocation.category}{allocation.location !== "—" ? ` · ${allocation.location}` : ""}</small><small>{allocation.linkStatus === "linked" ? "Linked" : "Awaiting registration"}</small></p>)}</div></details> : <span className="subtle">Provider dispute</span>}</td>
            <td className="payout-money good-text">{money(row.recoveredAmount)}</td>
            <td className="payout-money"><strong>{money(row.pendingAmount)}</strong></td>
            <td><span className={`status-pill ${row.status === "recovered" || row.status === "provider_credited" ? "good" : row.status === "awaiting_registration" || row.status === "planned_provider_dispute" || row.status === "under_provider_dispute" || row.status === "partially_recovered" ? "warn" : "payout-status-neutral"}`}>{statusLabels[row.status] ?? sentenceLabel(row.status)}</span>{linkStatus === "pending" ? <small>One or more IDs are awaiting registration</small> : null}</td>
            <td><strong>{row.providerReference || "No provider reference"}</strong><small>{row.reason || row.remark || "No reason or remark"}</small>{row.reason && row.remark ? <small>{row.remark}</small> : null}</td>
          </tr>;
        }) : <tr><td className="empty-cell" colSpan={11}>{invalidDateRange ? "Correct the date range to view recoveries." : "No payment recoveries match this view."}</td></tr>}</tbody>
      </table></div>
      <div className="workforce-advance-pagination"><label>Rows <select className="field" onChange={(event) => { setSize(event.target.value); setPage(1); }} value={size}><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="all">All</option></select></label><span>{filtered.length ? `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length}` : "0 records"} · Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))} type="button">Previous</button><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(Math.min(pages, safePage + 1))} type="button">Next</button></div>
    </section>
  </div>;
}
