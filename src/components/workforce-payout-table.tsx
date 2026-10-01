"use client";

import { useDeferredValue, useMemo, useState, type ReactElement } from "react";

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

type PayoutTableView = "overview" | "production" | "deductions" | "all";

const VIEW_OPTIONS: Array<{ id: PayoutTableView; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Review attendance, each mapped payment method, and final payable totals." },
  { id: "production", label: "Production", description: "See production units, rates, and amounts in one readable cell per activity." },
  { id: "deductions", label: "Deductions", description: "Focus on deduction heads and the resulting net pay." },
  { id: "all", label: "All details", description: "Open the complete audit worksheet with every unit, rate, and amount column." }
];

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
function units(value: number) { return value.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function workDaysValue(value: number, source: string) { return source.toLowerCase().includes("unavailable") ? "" : value; }
function workDaysDisplay(value: number, source: string) { return workDaysValue(value, source) === "" ? "—" : units(value); }
function amountDisplay(value: number) { return value ? money(value) : "—"; }
function statusTone(status: string) {
  if (status === "Ready for review") return "good";
  if (status === "Configuration incomplete") return "warn";
  return "payout-status-neutral";
}

export function WorkforcePayoutTable({ rows }: { rows: WorkforcePayoutRow[] }) {
  const [view, setView] = useState<PayoutTableView>("overview");
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("all");
  const [provider, setProvider] = useState("all");
  const [method, setMethod] = useState("all");
  const [status, setStatus] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("20");
  const [expandedId, setExpandedId] = useState("");
  const deferredSearch = useDeferredValue(search);
  const locationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.location || "-")).values()).sort(), [rows]);
  const providerOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.provider || "-")).values()).sort(), [rows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status || "-")).values()).sort(), [rows]);
  const methodOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.paymentMethodBreakdown.map((item) => item.label)))).sort((left, right) => left.localeCompare(right)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => {
    const term = deferredSearch.trim().toLowerCase();
    return (!term || `${row.dropxId} ${row.name} ${row.providerMemberId} ${row.providerMemberName}`.toLowerCase().includes(term))
      && (location === "all" || row.location === location)
      && (provider === "all" || row.provider === provider)
      && (method === "all" || row.paymentMethodBreakdown.some((item) => item.label === method))
      && (status === "all" || row.status === status);
  }), [rows, deferredSearch, location, provider, method, status]);
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
  const tableColumnCount = view === "overview"
    ? 10 + paymentMethodColumns.length
    : view === "production"
      ? 9 + productionColumns.length
      : view === "deductions"
        ? 8 + deductionColumns.length
        : 15 + paymentMethodColumns.length + deductionColumns.length + productionColumns.length * 3;
  const viewDescription = VIEW_OPTIONS.find((option) => option.id === view)?.description;

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
    const paymentMethodHeaders = paymentMethodColumns.map((item) => `${item.label} Amount`);
    const productionHeaders = productionColumns.flatMap((item) => [`${item.label} Count`, `${item.label} Rate`, `${item.label} Amount`]);
    const deductionHeaders = deductionColumns.map((item) => `${item.label} Deduction`);
    const columns = ["DropX ID","Registered Worker","Payment Source","Source ID","Location Code","Provider / Allocation","Model / Basis","Payment Method","Work Days","Attendance Source",...paymentMethodHeaders,...productionHeaders,"Base Amount","Additional Payments","Gross Payment",...deductionHeaders,"Gross Deductions","Net Pay","PAN-Aadhaar Status","Status"];
    const csv = [columns, ...filtered.map((row) => [row.dropxId,row.name,row.providerMemberName,row.providerMemberId,row.location,row.provider,row.model,row.paymentMethod,workDaysValue(row.workDays, row.workDaysSource),row.workDaysSource,...paymentMethodColumns.map((column) => row.paymentMethodBreakdown.find((item) => item.id === column.id)?.amount ?? 0),...productionColumns.flatMap((column) => { const item = row.productionBreakdown.find((value) => value.code === column.code); return [item?.count ?? 0,item?.rate ?? 0,item?.amount ?? 0]; }),row.baseAmount,row.additions,row.grossPayment,...deductionColumns.map((column) => row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0),row.deductions,row.netAmount,row.panAadhaarStatus,row.status])]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "workforce-payouts.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  return <>
    <div className="payout-table-toolbar">
      <div className="payout-view-picker">
        <span className="payout-toolbar-label">Worksheet view</span>
        <div className="segmented-control payout-view-switch" role="group" aria-label="Choose payout worksheet view">
          {VIEW_OPTIONS.map((option) => <button aria-pressed={view === option.id} className={view === option.id ? "active" : undefined} key={option.id} onClick={() => setView(option.id)} type="button">{option.label}</button>)}
        </div>
        <p>{viewDescription}</p>
      </div>
      <div className="payout-toolbar-actions">
        <button aria-controls="payout-filter-panel" aria-expanded={showFilters} className="button secondary" onClick={() => setShowFilters((current) => !current)} type="button">Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}</button>
        <button className="button secondary" type="button" onClick={exportRows}>Export full CSV</button>
      </div>
    </div>
    <div className="payout-search-strip">
      <label>
        <span className="payout-toolbar-label">Search workforce</span>
        <input className="field" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="DropX ID, worker, provider ID or name" />
      </label>
      <span aria-live="polite" className="payout-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
    </div>
    {showFilters ? <div className="payout-filter-panel" id="payout-filter-panel">
      <label>Location<select className="field" value={location} onChange={(event) => { setLocation(event.target.value); setPage(1); }}><option value="all">All allocated locations</option>{locationOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Provider<select className="field" value={provider} onChange={(event) => { setProvider(event.target.value); setPage(1); }}><option value="all">All providers</option>{providerOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Payment method<select className="field" value={method} onChange={(event) => { setMethod(event.target.value); setPage(1); }}><option value="all">All methods</option>{methodOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Status<select className="field" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option>{statusOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
    </div> : null}
    <div className="table-wrap payout-table-wrap">
      <table className={`workforce-payout-table workforce-payout-detail-table payout-view-${view}`}>
        <caption className="sr-only">Workforce payout worksheet. Current view: {VIEW_OPTIONS.find((option) => option.id === view)?.label}.</caption>
        <thead>
          {view === "overview" ? <tr>
            <th className="payout-sticky-id" scope="col">DropX ID</th>
            <th className="payout-sticky-worker" scope="col">Worker / payment source</th>
            <th scope="col">Location</th>
            <th scope="col">Allocation</th>
            <th className="work-days-group" scope="col">Work Days</th>
            {paymentMethodColumns.map((column) => <th className="payment-method-group" key={column.id} scope="col">{column.label}</th>)}
            <th scope="col">Gross Pay</th>
            <th scope="col">Deductions</th>
            <th scope="col">Net Pay</th>
            <th scope="col">Status</th>
            <th scope="col">Details</th>
          </tr> : null}
          {view === "production" ? <tr>
            <th className="payout-sticky-id" scope="col">DropX ID</th>
            <th className="payout-sticky-worker" scope="col">Worker / payment source</th>
            <th scope="col">Location</th>
            <th className="work-days-group" scope="col">Work Days</th>
            {productionColumns.map((column) => <th className="production-group" key={column.code} scope="col">{column.label}</th>)}
            <th scope="col">Base Amount</th>
            <th scope="col">Gross Pay</th>
            <th scope="col">Net Pay</th>
            <th scope="col">Status</th>
            <th scope="col">Details</th>
          </tr> : null}
          {view === "deductions" ? <tr>
            <th className="payout-sticky-id" scope="col">DropX ID</th>
            <th className="payout-sticky-worker" scope="col">Worker / payment source</th>
            <th scope="col">Location</th>
            <th scope="col">Gross Pay</th>
            {deductionColumns.map((column) => <th className="deduction-group" key={column.code} scope="col">{column.label}</th>)}
            <th scope="col">Gross Deductions</th>
            <th scope="col">Net Pay</th>
            <th scope="col">Status</th>
            <th scope="col">Details</th>
          </tr> : null}
          {view === "all" ? <><tr>
            <th className="payout-sticky-id" rowSpan={2} scope="col">DropX ID</th>
            <th className="payout-sticky-worker" rowSpan={2} scope="col">Registered Worker</th>
            <th rowSpan={2} scope="col">Payment Source</th>
            <th rowSpan={2} scope="col">Location Code</th>
            <th rowSpan={2} scope="col">Provider / Basis</th>
            <th rowSpan={2} scope="col">Payment Method</th>
            <th className="work-days-group" rowSpan={2} scope="col">Work Days</th>
            {paymentMethodColumns.map((column) => <th className="payment-method-group" colSpan={1} key={column.id} scope="colgroup">{column.label}</th>)}
            {productionColumns.map((column) => <th className="production-group" colSpan={3} key={column.code} scope="colgroup">{column.label}</th>)}
            <th rowSpan={2} scope="col">Base Amount</th>
            <th rowSpan={2} scope="col">Additional Payments</th>
            <th rowSpan={2} scope="col">Gross Payment</th>
            {deductionColumns.map((column) => <th rowSpan={2} className="deduction-group" key={column.code} scope="col">{column.label}</th>)}
            <th rowSpan={2} scope="col">Gross Deductions</th>
            <th rowSpan={2} scope="col">Net Pay</th>
            <th rowSpan={2} scope="col">PAN–Aadhaar</th>
            <th rowSpan={2} scope="col">Status</th>
            <th rowSpan={2} scope="col">Action</th>
          </tr><tr>
            {paymentMethodColumns.map((column) => <th className="payment-method-amount" key={`method-${column.id}-amount`} scope="col">Amount</th>)}
            {productionColumns.flatMap((column) => [
              <th key={`production-${column.code}-count`} scope="col">Units</th>,
              <th key={`production-${column.code}-rate`} scope="col">Rate</th>,
              <th key={`production-${column.code}-amount`} scope="col">Amount</th>
            ])}
          </tr></> : null}
        </thead>
        <tbody>
          {visible.length ? visible.flatMap((row) => {
            const expanded = expandedId === row.id;
            const detailId = `payout-breakup-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const identityCells = <>
              <td className="payout-sticky-id"><strong>{row.dropxId}</strong></td>
              <td className="payout-sticky-worker"><strong>{row.name}</strong><small title={`${row.providerMemberName} · ${row.providerMemberId}`}>{row.providerMemberName} · {row.providerMemberId}</small></td>
            </>;
            const statusCell = <td><div className="payout-status-stack"><span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span><span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus === "LINKED" ? "PAN linked" : "PAN not linked"}</span></div></td>;
            const detailButton = <td><button aria-controls={detailId} aria-expanded={expanded} className="button secondary compact" onClick={(event) => toggleBreakup(row.id, event.currentTarget)} type="button">{expanded ? "Close" : "Breakup"}</button></td>;
            return [
              <tr key={row.id} className={row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}>
                {view === "overview" ? <>
                  {identityCells}
                  <td><strong>{row.location}</strong></td>
                  <td><strong>{row.provider}</strong><small>{row.model} · {row.paymentMethod}</small></td>
                  <td className="work-days-cell"><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></td>
                  {paymentMethodColumns.map((column) => <td className="payment-method-amount payout-money" key={`overview-method-${column.id}`}><strong>{amountDisplay(row.paymentMethodBreakdown.find((item) => item.id === column.id)?.amount ?? 0)}</strong></td>)}
                  <td className="payout-money"><strong>{money(row.grossPayment)}</strong><small>Base {money(row.baseAmount)}{row.additions ? ` · +${money(row.additions)}` : ""}</small></td>
                  <td className="negative payout-money">{row.deductions ? `- ${money(row.deductions)}` : "—"}</td>
                  <td className="payout-money payout-net-pay"><strong>{money(row.netAmount)}</strong></td>
                  {statusCell}
                  {detailButton}
                </> : null}
                {view === "production" ? <>
                  {identityCells}
                  <td><strong>{row.location}</strong></td>
                  <td className="work-days-cell"><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></td>
                  {productionColumns.map((column) => {
                    const item = row.productionBreakdown.find((value) => value.code === column.code);
                    return <td className="payout-production-summary" key={`production-summary-${column.code}`}>{item?.amount || item?.count ? <><strong>{amountDisplay(item?.amount ?? 0)}</strong><small>{units(item?.count ?? 0)} units × {money(item?.rate ?? 0)}</small></> : "—"}</td>;
                  })}
                  <td className="payout-money">{money(row.baseAmount)}</td>
                  <td className="payout-money"><strong>{money(row.grossPayment)}</strong></td>
                  <td className="payout-money payout-net-pay"><strong>{money(row.netAmount)}</strong></td>
                  {statusCell}
                  {detailButton}
                </> : null}
                {view === "deductions" ? <>
                  {identityCells}
                  <td><strong>{row.location}</strong></td>
                  <td className="payout-money"><strong>{money(row.grossPayment)}</strong></td>
                  {deductionColumns.map((column) => { const value = row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0; return <td className="negative payout-money" key={column.code}>{value ? `- ${money(value)}` : "—"}</td>; })}
                  <td className="negative payout-money">{row.deductions ? `- ${money(row.deductions)}` : "—"}</td>
                  <td className="payout-money payout-net-pay"><strong>{money(row.netAmount)}</strong></td>
                  {statusCell}
                  {detailButton}
                </> : null}
                {view === "all" ? <>
                  <td className="payout-sticky-id"><strong>{row.dropxId}</strong></td>
                  <td className="payout-sticky-worker"><strong>{row.name}</strong></td>
                  <td><strong>{row.providerMemberName}</strong><small>{row.providerMemberId}</small></td>
                  <td><strong>{row.location}</strong></td>
                  <td>{row.provider}<small>{row.model}</small></td>
                  <td>{row.paymentMethod}</td>
                  <td className="work-days-cell"><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></td>
                  {paymentMethodColumns.map((column) => <td className="payment-method-amount payout-money" key={`method-${column.id}`}><strong>{amountDisplay(row.paymentMethodBreakdown.find((item) => item.id === column.id)?.amount ?? 0)}</strong></td>)}
                  {productionColumns.flatMap((column) => {
                    const item = row.productionBreakdown.find((value) => value.code === column.code);
                    return [
                      <td className="payout-money" key={`production-${column.code}-count`}>{item?.count ? units(item.count) : "—"}</td>,
                      <td className="payout-money" key={`production-${column.code}-rate`}>{item?.rate ? money(item.rate) : "—"}</td>,
                      <td className="payout-money" key={`production-${column.code}-amount`}><strong>{amountDisplay(item?.amount ?? 0)}</strong></td>
                    ];
                  })}
                  <td className="payout-money">{money(row.baseAmount)}</td>
                  <td className="positive payout-money">{row.additions ? `+ ${money(row.additions)}` : "—"}</td>
                  <td className="payout-money"><strong>{money(row.grossPayment)}</strong></td>
                  {deductionColumns.map((column) => { const value = row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0; return <td className="negative payout-money" key={column.code}>{value ? `- ${money(value)}` : "—"}</td>; })}
                  <td className="negative payout-money">{row.deductions ? `- ${money(row.deductions)}` : "—"}</td>
                  <td className="payout-money payout-net-pay"><strong>{money(row.netAmount)}</strong></td>
                  <td><span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus}</span></td>
                  <td><span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span></td>
                  {detailButton}
                </> : null}
              </tr>,
              expanded ? <tr className="payout-daily-detail-row" key={`${row.id}-daily`}>
                <td colSpan={tableColumnCount}>
                  <section className="payout-daily-detail" id={detailId}>
                    <header>
                      <span><small>DropX associate</small><strong>{row.name}</strong></span>
                      <span><small>Partner ID</small><strong>{row.providerMemberId}</strong></span>
                      <span><small>Partner name</small><strong>{row.providerMemberName}</strong></span>
                    </header>
                    <div className="payout-breakup-summary">
                      <span><small>Base pay</small><strong>{money(row.baseAmount)}</strong></span>
                      <span><small>Additions</small><strong className="positive">+ {money(row.additions)}</strong></span>
                      <span><small>Deductions</small><strong className="negative">- {money(row.deductions)}</strong></span>
                      <span><small>Net pay</small><strong>{money(row.netAmount)}</strong></span>
                    </div>
                    <div className="table-wrap payout-daily-table-wrap">
                      <table>
                        <caption className="sr-only">Daily payment breakup for {row.name}</caption>
                        <thead><tr>
                          <th scope="col">Date</th>
                          <th className="work-days-group" scope="col">Attendance</th>
                          {paymentMethodColumns.map((column) => <th className="payment-method-group" key={column.id} scope="col">{column.label}</th>)}
                          <th className="production-group" scope="col">Production details</th>
                          <th scope="col">Daily Payment</th>
                        </tr></thead>
                        <tbody>
                          {row.dailyBreakdown.map((day) => <tr key={day.date}>
                            <td><strong>{day.date.split("-").reverse().join("/")}</strong></td>
                            <td className="work-days-cell"><strong>{workDaysDisplay(day.workDayUnits, day.attendanceSource)}</strong><small>{day.attendanceSource}</small></td>
                            {paymentMethodColumns.map((column) => <td className="payment-method-amount payout-money" key={`daily-method-${column.id}`}><strong>{amountDisplay(day.methodAmounts.find((item) => item.id === column.id)?.amount ?? 0)}</strong></td>)}
                            <td className="payout-daily-production">{day.lines.some((line) => line.amount || line.count) ? day.lines.filter((line) => line.amount || line.count).map((line) => <span key={line.code}><strong>{line.label}</strong> {units(line.count)} × {money(line.rate)} = {money(line.amount)}</span>) : "—"}</td>
                            <td className="payout-money"><strong>{money(day.baseAmount)}</strong></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </td>
              </tr> : null
            ].filter(Boolean) as ReactElement[];
          }) : <tr><td className="empty-cell" colSpan={tableColumnCount}>No workforce payouts match the selected period and filters.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="pagination payout-pagination">
      <label className="payout-page-size">Rows per page<select className="field" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}>{["20","50","100","500","1000","all"].map((value) => <option value={value} key={value}>{value === "all" ? "All" : value}</option>)}</select></label>
      <span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span>
      <div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} type="button">Next</button></div>
    </div>
  </>;
}
