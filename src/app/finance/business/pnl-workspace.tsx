"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  Download,
  Info,
  TrendingUp,
} from "lucide-react";
import type { LivePnl } from "@/lib/finance/pnl-data";
import { pnlGroup, type PnlTotal, type PnlDay } from "@/lib/finance/pnl";
import { todayIndia } from "@/lib/finance/pricing";
import { PnlInsights } from "./pnl-insights";
import { LiveRefresh } from "./refresh";
import {
  RevenueCalculation,
  ExpenseCalculation,
  useFinanceEvidence,
} from "./pnl-calculations";

const money = (n: number | null, digits = 0) =>
  n === null
    ? "—"
    : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const count = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const dateLabel = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Not available";
const resultLabel = (profit: number | null) =>
  profit === null
    ? "P&L unavailable"
    : profit < 0
      ? "Loss"
      : profit > 0
        ? "Profit"
        : "Break-even";
const opsLink = (href: string) =>
  /^https:\/\/(?:dashboard|ops)\.dropxlogistics\.com\//.test(href)
    ? href
    : href.startsWith("/") && !href.startsWith("//")
      ? `https://ops.dropxlogistics.com${href}`
      : "https://ops.dropxlogistics.com/cps";

const titleForRows = (rows: PnlDay[]) => {
  const dates = rows
    .filter((d) => d.deliveries !== null)
    .map((d) => d.date)
    .sort();
  return dates.length
    ? `Calculated ${dateLabel(dates[0])} – ${dateLabel(dates.at(-1)!)}; same dates for revenue and expenses`
    : "No delivered-data report in the selected period";
};
function Statement({
  total,
  rows,
  report,
  showSummary = false,
}: {
  showSummary?: boolean;
  total: PnlTotal;
  rows: PnlDay[];
  report: LivePnl;
}) {
  const evidence = useFinanceEvidence(rows, report.readAt);
  const [openIncome, setOpenIncome] = useState<Set<string>>(() => new Set());
  const [openCosts, setOpenCosts] = useState<Set<string>>(() => new Set());
  const dayKeys = useMemo(
    () => new Set(rows.map((d) => `${d.station}/${d.date}`)),
    [rows],
  );
  const heads = useMemo(() => {
    const map = new Map<
      string,
      { label: string; head: string; source: string; amount: number }
    >();
    for (const c of report.costs)
      if (dayKeys.has(`${c.station_code}/${c.work_date}`)) {
        const key = `${c.head}/${c.sub_head}/${c.source}`,
          old = map.get(key);
        map.set(key, {
          label: c.sub_head,
          head: c.head,
          source: c.source,
          amount: (old?.amount ?? 0) + c.amount,
        });
      }
    return [...map.values()];
  }, [report.costs, dayKeys]);
  return (
    <>
      {showSummary && (
        <div
          className="pnl-simple-result"
          aria-label="Revenue, expenses and result"
        >
          <div>
            <small>Revenue</small>
            <strong>{money(total.revenue, 2)}</strong>
          </div>
          <div>
            <small>Expenses</small>
            <strong>{money(total.cost, 2)}</strong>
          </div>
          <div
            className={
              (total.profit ?? 0) < 0 ? "pnl-negative" : "pnl-positive"
            }
          >
            <small>{resultLabel(total.profit)}</small>
            <strong>
              {money(total.profit === null ? null : Math.abs(total.profit), 2)}
            </strong>
          </div>
        </div>
      )}
      <div className="pnl-statement">
        <section className="pnl-panel">
          <div className="pnl-panel-head">
            <div>
              <span className="pnl-eyebrow">Income</span>
              <h3>Revenue</h3>
            </div>
            <ArrowDownRight size={22} />
          </div>
          {(
            [
              ["base", "MG / fixed payout + monthly fee", total.base],
              [
                "variable",
                "Excess deliveries / delivery slabs",
                total.variable,
              ],
              ["swa", "SWA delivery earnings", total.swa],
              ["mfn", "MFN earnings", total.mfn],
            ] as const
          ).map(([kind, label, value]) => (
            <details
              className="pnl-expense"
              key={kind}
              onToggle={(e) => {
                const open = e.currentTarget.open;
                setOpenIncome((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(kind);
                  else next.delete(kind);
                  return next;
                });
              }}
            >
              <summary>
                <span>
                  <ChevronDown size={14} />
                  {label}
                </span>
                <strong>{money(value, 2)}</strong>
              </summary>
              {openIncome.has(kind) && (
                <RevenueCalculation kind={kind} rows={rows} report={report} />
              )}
            </details>
          ))}
          <div className="pnl-line pnl-total">
            <strong>Revenue</strong>
            <strong>{money(total.revenue, 2)}</strong>
          </div>
          <details className="pnl-source">
            <summary>
              Pricing & calculation <ChevronDown size={14} />
            </summary>
            <p>
              Fixed amounts accrue by actual calendar days. Excess delivery uses
              the effective rate card. SWA is priced separately and excluded
              from MG volume. Flipkart slabs use cumulative deliveries within
              each month.
            </p>
            <div className="pnl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Station / month</th>
                    <th>Effective card</th>
                    <th>Delivery rate</th>
                    <th>Monthly MG</th>
                  </tr>
                </thead>
                <tbody>
                  {report.pricing
                    .filter((p) =>
                      rows.some(
                        (r) =>
                          r.station === p.station &&
                          r.date.startsWith(p.month || "__"),
                      ),
                    )
                    .map((p, i) => (
                      <tr key={i}>
                        <td>
                          {p.station}
                          <small>{p.month}</small>
                        </td>
                        <td>
                          {p.effective || "Missing"} · v{p.revision ?? "—"}
                        </td>
                        <td>
                          {money(
                            p.variable === null ? null : Number(p.variable),
                            2,
                          )}
                        </td>
                        <td>{money(p.mg === null ? null : Number(p.mg), 2)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Link href="/master/pricing">Open Pricing Master →</Link>
          </details>
        </section>
        <section className="pnl-panel">
          <div className="pnl-panel-head">
            <div>
              <span className="pnl-eyebrow">Expenses</span>
              <h3>Expenses</h3>
            </div>
            <ArrowUpRight size={22} />
          </div>
          {[
            ["DA", "Delivery associates", total.da],
            ["UTR", "Station team & shared managers", total.utr],
            ["Van", "Vehicles, drivers & fuel", total.van],
            ["Rent", "Station rent & maintenance", total.rent],
            ["Other", "Other costs & overhead", total.other],
          ].map(([head, label, value]) => {
            const lines = heads.filter((c) =>
              head === "Other"
                ? ["Other", "Overhead"].includes(c.head)
                : c.head === head,
            );
            return (
              <details
                className="pnl-expense"
                key={String(head)}
                onToggle={(e) => {
                  const open = e.currentTarget.open;
                  if (open) evidence.load();
                  setOpenCosts((previous) => {
                    const next = new Set(previous);
                    if (open) next.add(String(head));
                    else next.delete(String(head));
                    return next;
                  });
                }}
              >
                <summary>
                  <span>
                    <ChevronDown size={14} /> {label}
                  </span>
                  <strong>
                    {total.cost === null ? "—" : money(value as number, 2)}
                  </strong>
                </summary>
                <div className="pnl-expense-detail">
                  {lines.length ? (
                    lines.map((l, i) => (
                      <div className="pnl-line" key={i}>
                        <span>
                          {l.label}
                          <small>{l.source}</small>
                        </span>
                        <strong>{money(l.amount, 2)}</strong>
                      </div>
                    ))
                  ) : (
                    <p>
                      No recorded cost in this head for these dates. Review
                      source coverage before treating it as complete.
                    </p>
                  )}
                  {openCosts.has(String(head)) && (
                    <ExpenseCalculation
                      head={String(head)}
                      evidence={evidence}
                    />
                  )}
                </div>
              </details>
            );
          })}
          <div className="pnl-line pnl-total">
            <strong>Expenses</strong>
            <strong>{money(total.cost, 2)}</strong>
          </div>
        </section>
      </div>
    </>
  );
}

export function PnlWorkspace({ report }: { report: LivePnl }) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const router = useRouter(),
    [pending, startTransition] = useTransition();
  const [filters, setFilters] = useState(report.filters),
    [view, setView] = useState<"regions" | "stations" | "months" | "daily">(
      "stations",
    );
  const [search, setSearch] = useState(""),
    [expanded, setExpanded] = useState<string | null>(null);
  const [stationSearch, setStationSearch] = useState("");
  const total = report.total,
    today = todayIndia();
  const href = (overrides: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      tab: "pnl",
      period: report.filters.period,
      month: report.filters.month,
      from: report.filters.from,
      to: report.filters.to,
      region: report.filters.region,
      cluster: report.filters.cluster,
      location: report.filters.location,
      provider: report.filters.provider,
      includeXpts: report.filters.includeXpts ? "1" : "0",
      ...overrides,
    });
    return `/finance/business?${q}`;
  };
  function apply(next = filters) {
    setFiltersOpen(false);
    const q = new URLSearchParams({
      tab: "pnl",
      period: next.period,
      month: next.month,
      from: next.from,
      to: next.to,
      region: next.region,
      cluster: next.cluster,
      location: next.location,
      provider: next.provider,
      includeXpts: next.includeXpts ? "1" : "0",
    });
    startTransition(() => router.push(`/finance/business?${q}`));
  }
  const issueStations = report.stations.filter((s) => s.issueDays).length;
  const entries = report[view].filter((r) =>
    r.key.toLowerCase().includes(search.toLowerCase()),
  );
  const issueGroups = useMemo(() => {
    const map = new Map<
      string,
      { station: string; issue: string; days: number; from: string; to: string }
    >();
    for (const d of report.days)
      for (const issue of d.issues) {
        const key = `${d.station}/${issue}`,
          v = map.get(key);
        map.set(key, {
          station: d.station,
          issue,
          days: (v?.days ?? 0) + 1,
          from: v?.from ?? d.date,
          to: d.date,
        });
      }
    return [...map.values()];
  }, [report.days]);
  const available = report.availability.shipments;
  const trendMax = Math.max(
    ...report.daily.flatMap((d) => [
      Math.abs(d.revenue ?? 0),
      Math.abs(d.cost ?? 0),
    ]),
    1,
  );
  return (
    <div className="live-pnl" aria-busy={pending}>
      <header className="pnl-header">
        <div>
          <span className="pnl-eyebrow">Finance · live operating view</span>
          <h1>Profit & loss</h1>
          <p>
            Your revenue, cost and margin — from business level to each station.
          </p>
        </div>
        <div className="pnl-actions">
          <LiveRefresh
            paused={
              pending ||
              JSON.stringify(filters) !== JSON.stringify(report.filters)
            }
          />
          <a
            className="pnl-btn primary"
            download
            href={href().replace(
              "/finance/business?",
              "/finance/business/export?",
            )}
          >
            <Download size={16} /> Download report
          </a>
        </div>
      </header>
      <nav className="pnl-tabs" aria-label="Business performance">
        <Link href="/finance/business?tab=revenue">Revenue & billing</Link>
        <span aria-current="page">Profit & loss</span>
      </nav>
      <form
        className="pnl-panel pnl-filters"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="pnl-shortcuts">
          {[
            ["today", "Today"],
            ["yesterday", "Yesterday"],
            ["mtd", "MTD"],
            ["last-month", "Last month"],
          ].map(([period, label]) => (
            <button
              type="button"
              className={filters.period === period ? "selected" : ""}
              key={period}
              disabled={pending}
              onClick={() => {
                const next = { ...filters, period };
                setFilters(next);
                apply(next);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
              start.setUTCMonth(start.getUTCMonth() - 5);
              const next = {
                ...filters,
                period: "custom",
                from: start.toISOString().slice(0, 10),
                to: today,
              };
              setFilters(next);
              apply(next);
            }}
          >
            Last 6 months
          </button>
          <span>Month or custom dates below</span>
        </div>
        <button type="button" className="pnl-filter-toggle" aria-expanded={filtersOpen} aria-controls="pnl-filter-fields" onClick={() => setFiltersOpen(!filtersOpen)}><span>Dates & stations <small>{report.filters.location || "All permitted stations"}</small></span><ChevronDown size={18} /></button>
        <div id="pnl-filter-fields" className={`pnl-filter-grid${filtersOpen ? " is-open" : ""}`}>
          <label>
            Period
            <select
              value={filters.period}
              onChange={(e) =>
                setFilters({ ...filters, period: e.target.value })
              }
            >
              <option value="mtd">Month to date</option>
              <option value="month">Calendar month</option>
              <option value="custom">Custom date range</option>
              <option value="last-month">Previous month</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
            </select>
          </label>
          {filters.period === "custom" ? (
            <>
              <label>
                From
                <input
                  type="date"
                  value={filters.from}
                  max={filters.to}
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    setFilters((current) => ({ ...current, from: value }));
                  }}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setFilters((current) => ({ ...current, from: value }));
                  }}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={filters.to}
                  min={filters.from}
                  max={today}
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    setFilters((current) => ({ ...current, to: value }));
                  }}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setFilters((current) => ({ ...current, to: value }));
                  }}
                />
              </label>
            </>
          ) : (
            <label>
              Month
              <input
                type="month"
                value={filters.month}
                max={today.slice(0, 7)}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    month: e.target.value,
                    period: "month",
                  })
                }
              />
            </label>
          )}
          <label>
            Client
            <select
              value={filters.provider}
              onChange={(e) =>
                setFilters({ ...filters, provider: e.target.value })
              }
            >
              <option value="">All clients</option>
              <option>Amazon</option>
              <option>Flipkart</option>
            </select>
          </label>
          <label>
            Region
            <select
              value={filters.region}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  region: e.target.value,
                  location: "",
                  cluster: "",
                })
              }
            >
              <option value="">All regions</option>
              {[...new Set(report.locations.map((l) => l.region))]
                .sort()
                .map((r) => (
                  <option key={r}>{r}</option>
                ))}
            </select>
          </label>
          <label>
            Cluster
            <select
              value={filters.cluster}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  cluster: e.target.value,
                  location: "",
                })
              }
            >
              <option value="">All clusters</option>
              {[
                ...new Set(
                  report.locations
                    .filter(
                      (l) => !filters.region || l.region === filters.region,
                    )
                    .map((l) => l.cluster),
                ),
              ]
                .sort()
                .map((r) => (
                  <option key={r}>{r}</option>
                ))}
            </select>
          </label>
          <label className="pnl-location">
            Station
            <input
              aria-label="Search station"
              placeholder="Search code or name"
              value={stationSearch}
              onChange={(e) => setStationSearch(e.target.value)}
            />
            <select
              aria-label="Select station"
              value={filters.location}
              onChange={(e) =>
                setFilters({ ...filters, location: e.target.value })
              }
            >
              <option value="">All permitted stations</option>
              {report.locations
                .filter(
                  (l) =>
                    (!filters.region || l.region === filters.region) &&
                    (!filters.cluster || l.cluster === filters.cluster) &&
                    (`${l.station_code} ${l.station_name}`
                      .toLowerCase()
                      .includes(stationSearch.toLowerCase()) ||
                      l.station_code === filters.location),
                )
                .map((l) => (
                  <option value={l.station_code} key={l.station_code}>
                    {l.station_code} · {l.station_name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Station scope
            <select
              value={filters.includeXpts ? "1" : "0"}
              onChange={(e) =>
                setFilters({ ...filters, includeXpts: e.target.value === "1" })
              }
            >
              <option value="1">Station + linked XPTs</option>
              <option value="0">Selected station only</option>
            </select>
          </label>
          <button className="pnl-btn primary" disabled={pending}>
            {pending ? "Loading…" : "Apply"}
          </button>
          <Link className="pnl-reset" href="/finance/business?tab=pnl">
            Reset
          </Link>
        </div>
      </form>
      <div className="pnl-period">
        <strong>
          {dateLabel(report.filters.from)} – {dateLabel(report.filters.to)}
        </strong>
        <span>
          {total.stations} {total.stations === 1 ? "station" : "stations"} ·
          each station counted once
        </span>
        <span>
          Shipment data: {dateLabel(available?.from)} –{" "}
          {dateLabel(available?.to)}
        </span>
      </div>
      {report.costError && (
        <p role="alert" className="pnl-notice">
          {report.costError}
        </p>
      )}
      {!total.stations ? (
        <div className="pnl-panel pnl-empty">
          No permitted stations match these filters. Reset or choose another
          location.
        </div>
      ) : (
        <>
          <div className="pnl-cutoff" role="status">
            <strong>
              Revenue and expenses use the same delivery-data cutoff.
            </strong>
            <p>
              Requested: {dateLabel(report.filters.from)} –{" "}
              {dateLabel(report.filters.to)}.{" "}
              {report.coverage.length === 1
                ? `Calculated through ${dateLabel(report.coverage[0].through)}.`
                : "Each station stops on its latest reported delivery date; see Data through below."}{" "}
              Dates after that cutoff are excluded from both sides. Monthly
              fixed costs are divided by the actual calendar days in that month;
              fuel uses dated transactions.
            </p>
          </div>
          <section className="pnl-kpis">
            <div>
              <span>Revenue</span>
              <strong>{money(total.revenue)}</strong>
              <small>{count(total.deliveries)} delivered shipments</small>
            </div>
            <div>
              <span>Expenses</span>
              <strong>{money(total.cost)}</strong>
              <small>Same live calculation as OpsPulse CPS</small>
            </div>
            <div
              className={`pnl-result ${(total.profit ?? 0) < 0 ? "loss" : ""}`}
            >
              <span>{resultLabel(total.profit)} · provisional</span>
              <strong>{money(total.profit)}</strong>
              <small>
                {total.margin === null
                  ? "Margin unavailable"
                  : `${total.margin.toFixed(1)}% operating margin`}{" "}
                · before final settlements
              </small>
            </div>
            <div className="pnl-unit">
              <span>Per delivered shipment</span>
              <div>
                <b>{money(total.rps, 2)}</b>
                <small>Revenue</small>
                <b>{money(total.cps, 2)}</b>
                <small>CPS</small>
              </div>
            </div>
          </section>
          <a className="pnl-coverage" href="#pnl-review">
            <Info size={18} />
            <span>
              <strong>
                {issueStations
                  ? `${issueStations} ${issueStations === 1 ? "station has" : "stations have"} incomplete inputs`
                  : "Source coverage"}
              </strong>{" "}
              · {total.shipmentDays}/{total.stationDays} station-days have
              shipment data. {report.reviews.length} mapping / cost items need
              review.
              <small>
                Known amounts are included; missing values are not treated as
                zero. P&L remains provisional until source gaps and settlement
                adjustments are resolved.
              </small>
            </span>
            <span>Review ↓</span>
          </a>
          <PnlInsights daily={report.daily} total={total} />
          <Statement total={total} rows={report.days} report={report} />
          <section className="pnl-panel">
            <div className="pnl-panel-head">
              <div>
                <span className="pnl-eyebrow">Compare & investigate</span>
                <h2>Where profit changes</h2>
              </div>
              <input
                className="pnl-search"
                aria-label="Search breakdown"
                placeholder="Search this view"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="pnl-view-tabs">
              {[
                ["stations", "By station"],
                ["regions", "By region"],
                ["months", "By month"],
                ["daily", "By day"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={view === key ? "selected" : ""}
                  onClick={() => {
                    setView(key as typeof view);
                    setExpanded(null);
                    setSearch("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="pnl-scroll">
              <table className="pnl-comparison-table">
                <thead>
                  <tr>
                    <th>
                      {view === "months"
                        ? "Month"
                        : view === "daily"
                          ? "Date"
                          : view === "regions"
                            ? "Region"
                            : "Station"}
                    </th>
                    <th>Delivered</th>
                    <th>Revenue</th>
                    <th>Expenses</th>
                    <th>Profit / Loss</th>
                    <th>CPS</th>
                    <th>Margin</th>
                    <th>Data through</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((row) => {
                    const rows = report.days.filter((d) =>
                      view === "stations"
                        ? d.station === row.key
                        : view === "regions"
                          ? d.region === row.key
                          : view === "months"
                            ? d.date.startsWith(row.key)
                            : d.date === row.key,
                    );
                    return (
                      <PnlTableRow
                        key={row.key}
                        row={row}
                        title={
                          view === "months"
                            ? monthLabel(row.key)
                            : view === "daily"
                              ? dateLabel(row.key)
                              : row.key
                        }
                        through={
                          rows
                            .filter((d) => d.deliveries !== null)
                            .map((d) => d.date)
                            .sort()
                            .at(-1) ?? null
                        }
                        open={expanded === row.key}
                        onToggle={() =>
                          setExpanded(expanded === row.key ? null : row.key)
                        }
                      >
                        <p className="pnl-expanded-period">
                          {titleForRows(rows)} · Revenue minus expenses ={" "}
                          {resultLabel(row.profit).toLowerCase()}. Amounts
                          remain provisional where inputs need review.
                        </p>
                        <Statement
                          total={row}
                          rows={rows}
                          report={report}
                          showSummary
                        />
                        {view !== "daily" && (
                          <details className="pnl-source">
                            <summary>
                              Daily revenue, expenses & profit / loss
                            </summary>
                            <div className="pnl-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Date</th>
                                    <th>Revenue</th>
                                    <th>Expenses</th>
                                    <th>Profit / Loss</th>
                                    <th>Deliveries</th>
                                    <th>CPS</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pnlGroup(rows, "date").map((d) => (
                                    <tr key={d.key}>
                                      <td>{dateLabel(d.key)}</td>
                                      <td>{money(d.revenue, 2)}</td>
                                      <td>{money(d.cost, 2)}</td>
                                      <td
                                        className={
                                          (d.profit ?? 0) < 0
                                            ? "pnl-negative"
                                            : "pnl-positive"
                                        }
                                      >
                                        {resultLabel(d.profit)}{" "}
                                        {money(
                                          d.profit === null
                                            ? null
                                            : Math.abs(d.profit),
                                          2,
                                        )}
                                      </td>
                                      <td>{count(d.deliveries)}</td>
                                      <td>{money(d.cps, 2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        )}
                        {view === "stations" && row.dataThrough && (
                          <a
                            className="pnl-btn"
                            href={opsLink(
                              `/cps?period=custom&from=${report.filters.from}&to=${row.dataThrough}&station=${encodeURIComponent(row.key)}`,
                            )}
                          >
                            Open full CPS & associate details →
                          </a>
                        )}
                      </PnlTableRow>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <td data-label="Delivered">{count(total.deliveries)}</td>
                    <td data-label="Revenue">{money(total.revenue)}</td>
                    <td data-label="Expenses">{money(total.cost)}</td>
                    <td data-label="Profit / loss">
                      {resultLabel(total.profit)}{" "}
                      {money(
                        total.profit === null ? null : Math.abs(total.profit),
                      )}
                    </td>
                    <td data-label="CPS">{money(total.cps, 2)}</td>
                    <td data-label="Margin">{total.margin?.toFixed(1) ?? "—"}%</td>
                    <td data-label="Reported days">
                      {total.shipmentDays}/{total.stationDays}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="pnl-footnote">
              Click a row to expand. CPS = total operating cost ÷ delivered
              shipments; region and business totals use weighted totals, never
              an average of station CPS.
            </p>
          </section>
          <details className="pnl-panel pnl-trend">
            <summary>
              <TrendingUp size={18} /> Daily revenue & cost trend{" "}
              <span>{report.daily.length} days</span>
            </summary>
            <div className="pnl-trend-legend">
              <i />
              Revenue <i />
              Cost
            </div>
            <div className="pnl-trend-grid">
              {report.daily.map((d) => (
                <div key={d.key} className="pnl-trend-row">
                  <span>{dateLabel(d.key)}</span>
                  <div>
                    <b
                      style={{
                        width: `${Math.max(0, ((d.revenue ?? 0) / trendMax) * 100)}%`,
                      }}
                      title={`Revenue ${money(d.revenue, 2)}`}
                    />
                    <i
                      style={{
                        width: `${Math.max(0, ((d.cost ?? 0) / trendMax) * 100)}%`,
                      }}
                      title={`Cost ${money(d.cost, 2)}`}
                    />
                  </div>
                  <small>
                    {money(d.revenue)} / {money(d.cost)}
                  </small>
                  <strong className={(d.profit ?? 0) < 0 ? "pnl-negative" : ""}>
                    {money(d.profit)}
                  </strong>
                </div>
              ))}
            </div>
          </details>
          <section id="pnl-review" className="pnl-panel">
            <div className="pnl-panel-head">
              <div>
                <span className="pnl-eyebrow">Data quality & leakage</span>
                <h2>Items to review</h2>
                <p>
                  Missing mappings, pricing and bill periods can change profit.
                  Resolve them at the source.
                </p>
              </div>
              <Link href="/master/pricing">Pricing Master →</Link>
            </div>
            <details>
              <summary className="pnl-review-summary">
                Mapping & cost inputs <b>{report.reviews.length}</b>
              </summary>
              <div className="pnl-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>What needs attention</th>
                      <th>ID / reference</th>
                      <th>Period</th>
                      <th>Deliveries affected</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.reviews.map((r, i) => (
                      <tr key={i}>
                        <td>{r.station}</td>
                        <td>{r.kind}</td>
                        <td>{r.reference}</td>
                        <td>
                          {r.from} – {r.to}
                        </td>
                        <td>{count(r.deliveries)}</td>
                        <td>
                          <a href={opsLink(r.href)}>Review source →</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!report.reviews.length && (
                  <p className="pnl-empty">
                    No mapping or bill-period items in these dates.
                  </p>
                )}
              </div>
            </details>
            <details>
              <summary className="pnl-review-summary">
                Revenue & daily coverage <b>{issueGroups.length}</b>
              </summary>
              <div className="pnl-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Gap</th>
                      <th>From</th>
                      <th>Through</th>
                      <th>Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issueGroups.map((r, i) => (
                      <tr key={i}>
                        <td>{r.station}</td>
                        <td>{r.issue}</td>
                        <td>{r.from}</td>
                        <td>{r.to}</td>
                        <td>{r.days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="pnl-assumptions">
              <strong>What this result includes</strong>
              <p>
                Live operating estimates using effective revenue cards and CPS
                source costs: mapped associate payouts, active station-team CTC
                and configured shared managers, deployed vehicles, fuel,
                approved ad hoc payments, rent, utilities and cashbook expenses.
                Fixed monthly costs accrue by the actual days in each calendar
                month.
              </p>
              <p>
                SWA uses a provisional matching delivery rate, editable in
                Pricing Master. Unconfigured IHS / SMD settlement rules,
                chargebacks, tax and unallocated corporate / HO costs are
                outside this operating result. They are not assumed to be zero
                or finalised profit.
              </p>
            </div>
          </section>
        </>
      )}
      <footer className="pnl-footer">
        <span>
          Refreshed{" "}
          {new Date(report.readAt).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })}{" "}
          IST · auto-refresh pauses while you edit filters or read expanded
          details
        </span>
        <div>
          {Object.entries(report.availability).map(([source, range]) => (
            <span key={source}>
              {source}: {dateLabel(range.from)} – {dateLabel(range.to)}
            </span>
          ))}
        </div>
      </footer>
    </div>
  );
}
function PnlTableRow({
  row,
  title,
  through,
  open,
  onToggle,
  children,
}: {
  row: PnlTotal;
  title: string;
  through: string | null;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr className="pnl-data-row">
        <th>
          <button onClick={onToggle} aria-expanded={open}>
            <ChevronDown
              size={14}
              style={{ transform: open ? "rotate(180deg)" : undefined }}
            />
            {title}
          </button>
        </th>
        <td data-label="Delivered">{count(row.deliveries)}</td>
        <td data-label="Revenue">{money(row.revenue)}</td>
        <td data-label="Expenses">{money(row.cost)}</td>
        <td data-label="Profit / loss" className={(row.profit ?? 0) < 0 ? "pnl-negative" : "pnl-positive"}>
          {resultLabel(row.profit)}{" "}
          {row.profit === null ? "" : money(Math.abs(row.profit))}
        </td>
        <td data-label="CPS">{money(row.cps, 2)}</td>
        <td data-label="Margin">{row.margin === null ? "—" : `${row.margin.toFixed(1)}%`}</td>
        <td data-label="Data through">
          <span className={row.issueDays ? "pnl-badge" : "pnl-badge good"}>
            {dateLabel(through)}
            <small>
              {row.shipmentDays}/{row.stationDays} reported days
            </small>
            {row.issueDays ? " · provisional" : ""}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="pnl-expanded-row">
          <td colSpan={8} className="pnl-expanded">
            {children}
          </td>
        </tr>
      )}
    </>
  );
}
