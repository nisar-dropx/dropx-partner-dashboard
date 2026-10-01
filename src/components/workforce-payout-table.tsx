"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

export type WorkforcePayoutRow = {
  id: string; dropxId: string; name: string; providerMemberId: string; providerMemberName: string; locationId: string | null;
  location: string; provider: string; model: string; paymentMethod: string; workDays: number; workDaysSource: string; production: number;
  paymentMethodBreakdown: Array<{ id: string; label: string; amount: number }>;
  productionBreakdown: Array<{ code: string; label: string; count: number; rate: number; amount: number }>;
  dailyBreakdown: Array<{
    date: string;
    workDayUnits: number;
    attendanceSource: string;
    methodAmounts: Array<{ id: string; label: string; amount: number }>;
    baseAmount: number;
    lines: Array<{ code: string; label: string; count: number; rate: number; amount: number }>;
  }>;
  baseAmount: number; additions: number; grossPayment: number; deductions: number; deductionBreakdown: Array<{ code: string; label: string; amount: number }>; panAadhaarStatus: "LINKED" | "NOT LINKED"; netAmount: number; status: string;
};

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
function rateMoney(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function units(value: number) { return value.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function workDaysValue(value: number, source: string) { return source.toLowerCase().includes("unavailable") ? "" : value; }
function workDaysDisplay(value: number, source: string) { return workDaysValue(value, source) === "" ? "—" : units(value); }
function statusTone(status: string) {
  if (status === "Ready for review") return "good";
  if (status === "Configuration incomplete") return "warn";
  return "payout-status-neutral";
}

function matchesFilters(row: WorkforcePayoutRow, search: string, location: string, provider: string, method: string, status: string) {
  const term = search.trim().toLowerCase();
  return (!term || `${row.dropxId} ${row.name} ${row.providerMemberId} ${row.providerMemberName}`.toLowerCase().includes(term))
    && (location === "all" || row.location === location)
    && (provider === "all" || row.provider === provider)
    && (method === "all" || row.paymentMethodBreakdown.some((item) => item.label === method))
    && (status === "all" || row.status === status);
}

export function WorkforcePayoutTable({ rows }: { rows: WorkforcePayoutRow[] }) {
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("all");
  const [provider, setProvider] = useState("all");
  const [method, setMethod] = useState("all");
  const [status, setStatus] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("20");
  const [expandedId, setExpandedId] = useState("");
  const [stickyScrollWidth, setStickyScrollWidth] = useState(0);
  const [stickyScrollFrame, setStickyScrollFrame] = useState({ left: 0, width: 0, visible: false });
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const stickyScrollRef = useRef<HTMLDivElement>(null);
  const deferredSearch = useDeferredValue(search);
  const locationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.location || "-")).values()).sort(), [rows]);
  const providerOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.provider || "-")).values()).sort(), [rows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status || "-")).values()).sort(), [rows]);
  const methodOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.paymentMethodBreakdown.map((item) => item.label)))).sort((left, right) => left.localeCompare(right)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => matchesFilters(row, deferredSearch, location, provider, method, status)), [rows, deferredSearch, location, provider, method, status]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const productionColumns = useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => row.productionBreakdown.forEach((item) => values.set(item.code, item.label)));
    const preferred = ["DELIVERY", "CRETURN", "SELLER_PICKUP", "SLLLER_RETURN"];
    return Array.from(values, ([code, label]) => ({ code, label })).sort((left, right) => {
      const leftIndex = preferred.indexOf(left.code); const rightIndex = preferred.indexOf(right.code);
      if (leftIndex === -1 && rightIndex === -1) return left.label.localeCompare(right.label);
      if (leftIndex === -1) return 1; if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  }, [rows]);
  const paymentMethodColumns = useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => row.paymentMethodBreakdown.forEach((item) => values.set(item.id, item.label)));
    return Array.from(values, ([id, label]) => ({ id, label })).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }, [rows]);
  const deductionColumns = useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => row.deductionBreakdown.forEach((item) => values.set(item.code, item.label)));
    return Array.from(values, ([code, label]) => ({ code, label })).sort((left, right) => left.label.localeCompare(right.label));
  }, [rows]);
  const activeFilterCount = [location, provider, method, status].filter((value) => value !== "all").length;
  const tableColumnCount = 11;

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
    setLocation("all"); setProvider("all"); setMethod("all"); setStatus("all"); setPage(1);
  }

  function toggleBreakup(rowId: string, button: HTMLButtonElement) {
    const opening = expandedId !== rowId;
    setExpandedId(opening ? rowId : "");
    const scrollArea = button.closest<HTMLElement>(".payout-table-wrap");
    if (opening && scrollArea?.scrollLeft) requestAnimationFrame(() => scrollArea.scrollTo({ left: 0, behavior: "smooth" }));
  }

  function exportRows() {
    const exportableRows = rows.filter((row) => matchesFilters(row, search, location, provider, method, status));
    const paymentMethodHeaders = paymentMethodColumns.map((item) => `${item.label} Amount`);
    const productionHeaders = productionColumns.flatMap((item) => [`${item.label} Count`, `${item.label} Rate`, `${item.label} Amount`]);
    const deductionHeaders = deductionColumns.map((item) => `${item.label} Deduction`);
    const columns = ["DropX ID","Registered Worker","Payment Source","Source ID","Location Code","Provider / Allocation","Model / Basis","Payment Method","Work Days","Attendance Source",...paymentMethodHeaders,...productionHeaders,"Base Amount","Additional Payments","Gross Payment",...deductionHeaders,"Gross Deductions","Net Pay","PAN-Aadhaar Status","Status"];
    const csv = [columns, ...exportableRows.map((row) => [row.dropxId,row.name,row.providerMemberName,row.providerMemberId,row.location,row.provider,row.model,row.paymentMethod,workDaysValue(row.workDays, row.workDaysSource),row.workDaysSource,...paymentMethodColumns.map((column) => row.paymentMethodBreakdown.find((item) => item.id === column.id)?.amount ?? 0),...productionColumns.flatMap((column) => { const item = row.productionBreakdown.find((value) => value.code === column.code); return [item?.count ?? 0,item?.rate ?? 0,item?.amount ?? 0]; }),row.baseAmount,row.additions,row.grossPayment,...deductionColumns.map((column) => row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0),row.deductions,row.netAmount,row.panAadhaarStatus,row.status])]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "workforce-payouts.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  return <>
    <div className="payout-search-strip">
      <label>
        <span className="payout-toolbar-label">Search workforce</span>
        <input className="field" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="DropX ID, worker, provider ID or name" />
      </label>
      <div className="payout-search-controls">
        <span aria-live="polite" className="payout-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
        <button aria-controls="payout-filter-panel" aria-expanded={showFilters} className="button secondary" onClick={() => setShowFilters((current) => !current)} type="button">Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}</button>
        <button className="button secondary" type="button" onClick={exportRows}>Export full CSV</button>
      </div>
    </div>
    {showFilters ? <div className="payout-filter-panel" id="payout-filter-panel">
      <label>Location<select className="field" value={location} onChange={(event) => { setLocation(event.target.value); setPage(1); }}><option value="all">All allocated locations</option>{locationOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Provider<select className="field" value={provider} onChange={(event) => { setProvider(event.target.value); setPage(1); }}><option value="all">All providers</option>{providerOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Payment method<select className="field" value={method} onChange={(event) => { setMethod(event.target.value); setPage(1); }}><option value="all">All methods</option>{methodOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Status<select className="field" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option>{statusOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
    </div> : null}
    <div className="table-wrap payout-table-wrap" ref={tableWrapRef}>
      <table className="workforce-payout-table workforce-payout-detail-table payout-view-overview">
        <caption className="sr-only">Workforce payout totals</caption>
        <thead><tr>
          <th className="payout-sticky-id" scope="col">DropX ID</th>
          <th className="payout-sticky-worker" scope="col">Worker / payment source</th>
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
              <tr key={row.id} className={row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}>
                <td className="payout-sticky-id"><strong>{row.dropxId}</strong></td>
                <td className="payout-sticky-worker"><strong>{row.name}</strong><small title={`${row.providerMemberName} · ${row.providerMemberId}`}>{row.providerMemberName} · {row.providerMemberId}</small></td>
                <td><strong>{row.location}</strong></td>
                <td><strong>{row.provider}</strong><small>{row.model}</small></td>
                <td><strong>{row.paymentMethod}</strong></td>
                <td className="work-days-cell"><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></td>
                <td className="payout-money"><strong>{money(row.grossPayment)}</strong></td>
                <td className="negative payout-money">{row.deductions ? `- ${money(row.deductions)}` : "—"}</td>
                <td className="payout-money payout-net-pay"><strong>{money(row.netAmount)}</strong></td>
                <td><div className="payout-status-stack"><span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span><span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus === "LINKED" ? "PAN linked" : "PAN not linked"}</span></div></td>
                <td><button aria-controls={detailId} aria-expanded={expanded} className="button secondary compact" onClick={(event) => toggleBreakup(row.id, event.currentTarget)} type="button">{expanded ? "Close" : "Breakup"}</button></td>
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
          }) : <tr><td className="empty-cell" colSpan={tableColumnCount}>No workforce payouts match the selected period and filters.</td></tr>}
        </tbody>
      </table>
    </div>
    <div
      aria-label="Workforce payout horizontal scrollbar"
      className={`payout-sticky-scroll ${stickyScrollFrame.visible ? "visible" : ""}`}
      ref={stickyScrollRef}
      role="region"
      style={{ left: stickyScrollFrame.left, width: stickyScrollFrame.width }}
      tabIndex={stickyScrollFrame.visible ? 0 : -1}
    >
      <div style={{ width: stickyScrollWidth }} />
    </div>
    <div className="pagination payout-pagination">
      <label className="payout-page-size">Rows per page<select className="field" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}>{["20","50","100","500","1000","all"].map((value) => <option value={value} key={value}>{value === "all" ? "All" : value}</option>)}</select></label>
      <span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span>
      <div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} type="button">Next</button></div>
    </div>
  </>;
}
