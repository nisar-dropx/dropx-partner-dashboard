"use client";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Download } from "lucide-react";
import type { LivePnl } from "@/lib/finance/pnl-data";
import { comparisonColumns, comparisonFocuses, comparisonSelection, comparisonTitle, comparisonViews, matchesFocus, pnlResultClass, pnlResultLabel, type ComparisonOptions, type ComparisonRow, type ComparisonSort, type ComparisonView } from "@/lib/finance/pnl-comparison";

const money = (n: number | null, digits = 0) => n === null ? "—" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const date = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Unavailable";
export function PnlComparison({ report, href, renderDetails }: { report: LivePnl; href: (overrides: Record<string, string>) => string; renderDetails: (row: ComparisonRow, view: ComparisonView) => ReactNode }) {
  const [options, setOptions] = useState<ComparisonOptions>({ view: "stations", focus: "all", search: "", sort: "key", direction: "asc" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [format, setFormat] = useState("xlsx");
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState("");
  const { all, entries, total } = useMemo(() => comparisonSelection(report, options), [report, options]);
  const pageSize = 25, pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(page, pages - 1), visible = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const name = options.view === "stations" ? "Station group" : options.view === "regions" ? "Region" : options.view === "months" ? "Month" : "Date";
  const loss = all.filter(r => r.profit !== null && r.profit < 0).reduce((n, r) => n + r.profit!, 0);
  function change(next: Partial<ComparisonOptions>) { setOptions(old => ({ ...old, ...next })); setPage(0); setExpanded(null); }
  function sort(key: ComparisonSort) { change({ sort: key, direction: options.sort === key && options.direction === "asc" ? "desc" : "asc" }); }
  async function download() {
    setDownloading(true); setExportError("");
    try {
      const url = href({ ...options, format }).replace("/finance/business?", "/finance/business/export?");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok || response.redirected || response.headers.get("content-type")?.includes("text/html")) throw Error("Export could not be prepared. Refresh the page and try again.");
      const blob = await response.blob(), objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = objectUrl;
      link.download = `profit-loss-${options.view}-${report.filters.from}-to-${report.filters.to}.${format}`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) { setExportError(error instanceof Error ? error.message : "Export failed. Please retry."); }
    finally { setDownloading(false); }
  }
  return <section className="pnl-panel pnl-compare" id="pnl-comparison" aria-labelledby="pnl-comparison-title" data-exporting={downloading}>
    <div className="pnl-panel-head"><div><span className="pnl-eyebrow">Compare & investigate</span><h2 id="pnl-comparison-title">Where profit changes</h2><p>EDSP parents include their linked XPTs. Expand a row for the full calculation.</p></div>
      <div className="pnl-export-controls"><label className="pnl-sr-only" htmlFor="pnl-export-format">Export format</label><select id="pnl-export-format" value={format} onChange={e => setFormat(e.target.value)}><option value="xlsx">Excel · with details</option><option value="pdf">PDF · comparison</option><option value="csv">CSV · comparison</option></select><button className="pnl-btn primary" onClick={download} disabled={downloading || !entries.length}><Download size={15} />{downloading ? "Preparing…" : "Export view"}</button></div>
    </div>
    {exportError && <p className="pnl-notice" role="alert">{exportError}</p>}
    <div className="pnl-view-tabs" role="group" aria-label="Comparison grouping">{Object.entries(comparisonViews).map(([key, label]) => <button key={key} aria-pressed={options.view === key} className={options.view === key ? "selected" : ""} onClick={() => change({ view: key as ComparisonView, search: "", focus: "all", sort: "key", direction: "asc" })}>{label}</button>)}</div>
    <div className="pnl-focus-chips" role="group" aria-label="Filter financial results">{Object.entries(comparisonFocuses).map(([key, label]) => <button key={key} aria-pressed={options.focus === key} onClick={() => change({ focus: key as ComparisonOptions["focus"] })}>{label}<b>{all.filter(r => matchesFocus(r, key as ComparisonOptions["focus"])).length}</b></button>)}</div>
    <div className="pnl-comparison-tools"><label className="pnl-search-label">Search {options.view === "stations" ? "station or XPT" : "this view"}<input className="pnl-search" placeholder={options.view === "stations" ? "Code, XPT or station name" : "Search this view"} value={options.search} onChange={e => change({ search: e.target.value })} /></label><label>Sort by<select aria-label="Sort comparison by" value={options.sort} onChange={e => change({ sort: e.target.value as ComparisonSort })}>{comparisonColumns.map(c => <option key={c.key} value={c.key}>{c.key === "key" ? name : c.label}</option>)}</select></label><button className="pnl-btn" aria-label={`Sort ${options.direction === "asc" ? "descending" : "ascending"}`} onClick={() => change({ direction: options.direction === "asc" ? "desc" : "asc" })}>{options.direction === "asc" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}{options.direction === "asc" ? "Ascending" : "Descending"}</button>{(options.search || options.focus !== "all") && <button className="pnl-btn" onClick={() => change({ search: "", focus: "all" })}>Clear filters</button>}</div>
    <div className="pnl-comparison-context" aria-live="polite"><span><b>{entries.length}</b> of {all.length} results · {date(report.filters.from)} – {date(report.filters.to)}</span>{loss < 0 && <button onClick={() => change({ focus: "loss", search: "", sort: "profit", direction: "asc" })} className="pnl-loss-link">{money(Math.abs(loss))} loss across loss-making {options.view === "stations" ? "station groups" : "results"} →</button>}<small>Exports include all matching rows, in this order, plus cutoff and review information.</small></div>
    <div className="pnl-scroll"><table className="pnl-comparison-table"><caption className="pnl-sr-only">{comparisonViews[options.view]} · {comparisonFocuses[options.focus]} · {entries.length} matching results</caption><thead><tr>{comparisonColumns.map(c => <th key={c.key} scope="col" aria-sort={options.sort === c.key ? options.direction === "asc" ? "ascending" : "descending" : "none"}><button className="pnl-sort-heading" onClick={() => sort(c.key)}>{c.key === "key" ? name : c.label}{options.sort === c.key ? options.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</button></th>)}</tr></thead>
      <tbody>{visible.map(row => <ComparisonRowView key={row.key} row={row} title={comparisonTitle(row.key, options.view)} open={expanded === row.key} toggle={() => setExpanded(expanded === row.key ? null : row.key)}>{expanded === row.key ? renderDetails(row, options.view) : null}</ComparisonRowView>)}{!entries.length && <tr><td colSpan={8} className="pnl-empty">No results match this view. Clear the search or choose All results.</td></tr>}</tbody>
      {!!entries.length && <tfoot><tr><th scope="row">Shown results<small>{entries.length} rows · all pages</small></th><td data-label="Delivered">{total.deliveries?.toLocaleString("en-IN") ?? "—"}</td><td data-label="Revenue">{money(total.revenue)}</td><td data-label="Expenses">{money(total.cost)}</td><td data-label="Profit / loss" className={pnlResultClass(total.profit)}>{pnlResultLabel(total.profit)} {total.profit !== null ? money(Math.abs(total.profit)) : ""}</td><td data-label="CPS">{money(total.cps, 2)}</td><td data-label="Margin">{total.margin === null ? "—" : `${total.margin.toFixed(1)}%`}</td><td data-label="Coverage">{total.shipmentDays}/{total.stationDays}<small>reported station-days</small></td></tr></tfoot>}
    </table></div>
    <div className="pnl-comparison-context"><span>{entries.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, entries.length)} of ${entries.length}` : "0 results"}</span>{pages > 1 && <div className="pnl-actions"><button className="pnl-btn" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setExpanded(null); }}>Previous</button><span>Page {currentPage + 1} / {pages}</span><button className="pnl-btn" disabled={currentPage + 1 === pages} onClick={() => { setPage(currentPage + 1); setExpanded(null); }}>Next</button></div>}<small>Shown totals follow these filters; overview totals above cover the entire report. CPS and margin use weighted totals. Missing inputs remain provisional.</small></div>
  </section>;
}
function ComparisonRowView({ row, title, open, toggle, children }: { row: ComparisonRow; title: string; open: boolean; toggle: () => void; children: ReactNode }) {
  const mixed = row.earliestThrough !== row.dataThrough;
  return <><tr className="pnl-data-row"><th scope="row"><button onClick={toggle} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${title}`}><ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined }} /><span>{title}<small>{row.subtitle}</small></span></button></th><td data-label="Delivered">{row.deliveries?.toLocaleString("en-IN") ?? "—"}</td><td data-label="Revenue">{money(row.revenue)}</td><td data-label="Expenses">{money(row.cost)}</td><td data-label="Profit / loss" className={pnlResultClass(row.profit)}>{pnlResultLabel(row.profit)} {row.profit !== null ? money(Math.abs(row.profit)) : ""}</td><td data-label="CPS">{money(row.cps, 2)}</td><td data-label="Margin">{row.margin === null ? "—" : `${row.margin.toFixed(1)}%`}</td><td data-label="Data through"><span>{mixed ? `${date(row.earliestThrough)} – ${date(row.dataThrough)}` : date(row.dataThrough)}</span><small>{mixed ? "Different station cutoffs · " : ""}{row.shipmentDays}/{row.stationDays} station-days{row.missingMembers ? ` · ${row.missingMembers} without data` : ""}</small>{row.issueDays > 0 && <span className="pnl-review-tag">Needs review</span>}</td></tr>{open && <tr className="pnl-expanded-row"><td colSpan={8} className="pnl-expanded">{children}</td></tr>}</>;
}
