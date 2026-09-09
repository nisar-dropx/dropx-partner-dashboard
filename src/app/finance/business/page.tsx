import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission } from "@/lib/authorization";
import { financeContext, loadBusiness, type Query } from "@/lib/finance/data";
import { addAmounts, monthEnd } from "@/lib/finance/pricing";
import { DailyBreakup } from "./daily-breakup";
import { LiveRefresh } from "./refresh";
import { BusinessFilters } from "./filters";
import "../finance.css";
import "../business.css";
export const dynamic = "force-dynamic";
const money = (v: string | null) =>
  v === null
    ? "Unavailable"
    : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quantity = (v: string | null) =>
  v === null
    ? "—"
    : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const stamp = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }) + " IST"
    : "No report";
export default async function BusinessPage({
  searchParams = {},
}: {
  searchParams?: Query;
}) {
  const tab = searchParams.tab === "pnl" ? "pnl" : "revenue";
  const context = await financeContext(
    tab === "pnl" ? "finance_pnl" : "finance_revenue",
  );
  let report: Awaited<ReturnType<typeof loadBusiness>> | null = null;
  let error = "";
  try {
    report = await loadBusiness(context, searchParams);
  } catch (e) {
    error =
      e instanceof Error ? e.message : "Unable to load Business Performance.";
  }
  if (!report)
    return (
      <AppShell
        active={tab === "pnl" ? "Profit & Loss" : "Revenue & Billing"}
        pageCode={tab === "pnl" ? "finance_pnl" : "finance_revenue"}
      >
        <PageHead title="Business Performance" />
        <div role="alert" className="fin-notice error">
          {error}
        </div>
        <Link className="button" href={`/finance/business?tab=${tab}`}>
          Reset filters and retry
        </Link>
      </AppShell>
    );
  const { rows, filters, snapshot, readAt } = report;
  const params = new URLSearchParams({ ...filters, tab });
  const tabHref = (next: string) => {
    const q = new URLSearchParams(params);
    q.set("tab", next);
    return `/finance/business?${q}`;
  };
  const dailySelection =
    typeof searchParams.daily === "string" ? searchParams.daily : "";
  const dailyRows =
    dailySelection === "all"
      ? rows
      : rows.filter(
          (r) =>
            r.station === dailySelection &&
            r.provider === searchParams.dailyClient,
        );
  const dailyHref = (station = "all", client = "") => {
    const q = new URLSearchParams(params);
    q.set("daily", station);
    if (client) q.set("dailyClient", client);
    return `/finance/business?${q}#daily-breakup`;
  };
  const dailyExport = new URLSearchParams(params);
  dailyExport.set("detail", "daily");
  dailyExport.set("daily", dailySelection);
  if (typeof searchParams.dailyClient === "string")
    dailyExport.set("dailyClient", searchParams.dailyClient);
  const comparable = rows.filter((r) => r.profit !== null);
  const revenue = addAmounts(rows.map((r) => r.revenue)),
    costs = addAmounts(rows.map((r) => r.cost)),
    profit = addAmounts(comparable.map((r) => r.profit));
  const revenueCovered = rows.filter((r) => r.revenue !== null).length;
  const missing = rows.filter(
    (r) => r.revenue === null || r.cost === null,
  ).length;
  const sourceShipment =
    snapshot.shipments
      .map((s) => s.updated_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const sourceCost =
    snapshot.costs
      .map((c) => c.updated_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const elapsed = Number(filters.through.slice(8));
  return (
    <AppShell
      active={tab === "pnl" ? "Profit & Loss" : "Revenue & Billing"}
      pageCode={tab === "pnl" ? "finance_pnl" : "finance_revenue"}
    >
      <PageHead
        eyebrow="Finance · Live estimates"
        title="Business Performance"
        subtitle="Track revenue and operating profitability by allocation, using monthly pricing and the latest imported delivery and cost reports."
        action={
          <div className="fin-actions">
            <LiveRefresh />
            <a className="button" href={`/finance/business/export?${params}`}>
              Download CSV
            </a>
          </div>
        }
      />
      <nav className="fin-tabs" aria-label="Business Performance sections">
        {hasPermission(context.authorization, "finance_revenue", "access") && (
          <Link
            className={tab === "revenue" ? "active" : ""}
            href={tabHref("revenue")}
            aria-current={tab === "revenue" ? "page" : undefined}
          >
            Revenue & Billing
          </Link>
        )}
        {hasPermission(context.authorization, "finance_pnl", "access") && (
          <Link
            className={tab === "pnl" ? "active" : ""}
            href={tabHref("pnl")}
            aria-current={tab === "pnl" ? "page" : undefined}
          >
            Profit & Loss
          </Link>
        )}
      </nav>
      <BusinessFilters
        key={params.toString()}
        initial={filters}
        tab={tab}
        locations={context.locations.map((l) => ({
          code: l.station_code,
          name: l.station_name || l.station_code,
          region: l.region || "Unassigned",
          cluster: l.cluster || "Unassigned",
        }))}
      />
      <div className="fin-period-line">
        <strong>
          {filters.month} · 1–{elapsed}{" "}
          {new Date(`${filters.month}-01T00:00:00+05:30`).toLocaleString(
            "en-IN",
            { month: "long", timeZone: "Asia/Kolkata" },
          )}
        </strong>
        <Link
          href={`/finance/business?month=2026-08&through=2026-08-31&tab=${tab}`}
        >
          View August 2026 MG period
        </Link>
        {hasPermission(context.authorization, "finance_pricing", "access") && (
          <Link href="/master/pricing">Open Pricing Master →</Link>
        )}
      </div>
      <section className="summary-grid">
        <div className="metric-card">
          <span>MTD revenue · estimate</span>
          <Link className="fin-metric-link" href={dailyHref()}>
            <strong>{money(revenue)}</strong>
            <small>View daily breakup →</small>
          </Link>
          <small>
            {revenueCovered} of {rows.length} allocations priced
          </small>
        </div>
        <div className="metric-card">
          <span>Recorded operating costs</span>
          <strong>{money(costs)}</strong>
          <small>
            {rows.filter((r) => r.cost !== null).length} allocations with
            attributable costs
          </small>
        </div>
        <div className="metric-card">
          <span>MTD P&L · estimate</span>
          <strong
            className={
              profit !== null && Number(profit) < 0 ? "fin-negative" : ""
            }
          >
            {money(profit)}
          </strong>
          <small>
            {comparable.length} allocations with both revenue and cost
          </small>
        </div>
        <div className="metric-card">
          <span>Missing pricing or costs</span>
          <strong>{missing}</strong>
          <small>Unavailable values are excluded, never treated as zero</small>
        </div>
      </section>
      <div className="fin-notice">
        <strong>Management estimate, before final billing.</strong> Amazon uses
        monthly MG × {elapsed}/{monthEnd(filters.month).slice(8)} calendar days.
        Each day adds max(0, deliveries − monthly MG volume ÷ calendar days) ×
        variable slab rate, plus MFN count × MFN rate. IHS/SMD settlement rules,
        recoveries, fees and tax remain outside this estimate. Flipkart uses
        configured monthly delivery slabs. P&L subtracts recorded operating
        costs only; missing expense days and unallocated overhead can overstate
        profit.
      </div>
      <div className="fin-freshness">
        <span>Live refresh every 60 seconds · Read {stamp(readAt)}</span>
        <span>
          Shipment source updated {stamp(sourceShipment)} · Cost source updated{" "}
          {stamp(sourceCost)}
        </span>
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>
              {tab === "pnl"
                ? "MTD allocation profitability"
                : "MTD allocation revenue"}
            </h2>
            <p className="subtle">
              Allocation = location + client. {rows.length} matching
              allocations. Click an MTD revenue amount for the daily breakup.
            </p>
          </div>
        </div>
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>Allocation</th>
                <th>Region / cluster</th>
                <th>Deliveries</th>
                {tab === "revenue" && <th>Monthly MG</th>}
                <th>MTD revenue</th>
                {tab === "pnl" && (
                  <>
                    <th>Recorded costs</th>
                    <th>Estimated P&L</th>
                  </>
                )}
                <th>Coverage / details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.station}/${row.provider}`}>
                  <td>
                    <strong>
                      {row.station} · {row.provider}
                    </strong>
                    <small>{row.name}</small>
                  </td>
                  <td>
                    {row.region}
                    <small>{row.cluster}</small>
                  </td>
                  <td>
                    {quantity(row.deliveries)}
                    <small>
                      {row.shipmentThrough
                        ? `Through ${row.shipmentThrough}`
                        : "No shipment report"}
                    </small>
                  </td>
                  {tab === "revenue" && (
                    <td>
                      {row.mg === null ? "—" : money(row.mg)}
                      <small>
                        {row.mgVolume
                          ? `Volume: ${quantity(row.mgVolume)}`
                          : row.basis}
                      </small>
                    </td>
                  )}
                  <td>
                    <Link
                      className="fin-revenue-link"
                      href={dailyHref(row.station, row.provider)}
                    >
                      {money(row.revenue)}
                      <small>View daily breakup →</small>
                    </Link>
                    <small>
                      {row.revision
                        ? `Rate revision ${row.revision}`
                        : "Rate card needed"}
                    </small>
                  </td>
                  {tab === "pnl" && (
                    <>
                      <td>
                        {money(row.cost)}
                        <small>
                          {row.costThrough
                            ? `Through ${row.costThrough}`
                            : "No cost report"}
                        </small>
                      </td>
                      <td
                        className={
                          row.profit !== null && Number(row.profit) < 0
                            ? "fin-negative"
                            : ""
                        }
                      >
                        <strong>{money(row.profit)}</strong>
                      </td>
                    </>
                  )}
                  <td>
                    <details className="fin-row-details">
                      <summary>
                        <span
                          className={`fin-chip ${row.revenue === null || row.cost === null ? "warning" : ""}`}
                        >
                          {row.revenue === null
                            ? "Pricing / data needed"
                            : row.cost === null
                              ? "Costs unavailable"
                              : "Estimate"}
                        </span>
                        <small>
                          Shipments {row.shipmentDays}/{elapsed} days · Costs{" "}
                          {row.costDays}/{elapsed} days
                        </small>
                      </summary>
                      <p>
                        <strong>{row.basis}</strong>
                      </p>
                      {row.issues.length > 0 && (
                        <ul>
                          {row.issues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      )}
                      {tab === "pnl" && row.components && (
                        <dl className="fin-costs">
                          {(
                            [
                              ["DA pay", "da"],
                              ["Staff", "staff"],
                              ["Fuel", "fuel"],
                              ["Vehicle", "vehicle"],
                              ["Rent", "rent"],
                              ["Other", "other"],
                              ["UTR", "utr"],
                              ["Van", "van"],
                            ] as const
                          ).map(([label, key]) => (
                            <div key={key}>
                              <dt>{label}</dt>
                              <dd>{money(row.components![key])}</dd>
                            </div>
                          ))}
                          <p>
                            Source total: {money(row.cost)}. Components are
                            informational; they are not added again to the
                            source total.
                          </p>
                        </dl>
                      )}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="fin-empty">
            <h3>No data for these filters</h3>
            <p>
              No matching pricing, shipment or cost records have been imported
              for this period. Try August 2026 or another location.
            </p>
          </div>
        )}
      </section>
      {dailySelection &&
        (dailyRows.length ? (
          <DailyBreakup
            rows={dailyRows}
            pnl={tab === "pnl"}
            download={`/finance/business/export?${dailyExport}`}
            close={`/finance/business?${params}`}
          />
        ) : (
          <div className="fin-notice">
            No permitted allocation matches this daily breakup. Choose an
            allocation from the MTD table.
          </div>
        ))}
      <p className="fin-footnote">
        Revenue follows the latest revision for the selected month. Recorded
        costs come from station cost reports; payment requests and bank payments
        are not added again. Shared station costs are excluded from client P&L
        until an allocation basis is available. These estimates are not tax
        invoices or a closed accounting P&L.
      </p>
    </AppShell>
  );
}
