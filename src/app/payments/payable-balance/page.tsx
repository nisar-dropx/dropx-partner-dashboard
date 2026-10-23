import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import {
  PAYABLE_BALANCE_SOURCE_LABELS,
  payableBalanceMonthLabel,
  payableBalanceMonthRange,
  summarizePayableBalance,
  summarizePayableBalanceByMonthAndSource,
  summarizePayableBalanceBySource
} from "@/lib/payable-balance";
import { loadPayableBalance } from "@/lib/payable-balance-loader";

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function currency(value: number) {
  return money.format(value);
}

function selectedPeriod(value: string | string[] | undefined) {
  const requested = typeof value === "string" ? value : "";
  if (requested === "all-pending" || payableBalanceMonthRange(requested)) return requested;
  return todayKolkata().slice(0, 7);
}

export const dynamic = "force-dynamic";

export default async function PayableBalancePage({
  searchParams = {}
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const pageCode = "payable_balance";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const period = selectedPeriod(searchParams.period);
  const pendingOnly = period === "all-pending";
  const loaded = await loadPayableBalance(companyId, authorization, period);
  const total = loaded.error ? null : summarizePayableBalance(loaded.grains, { pendingOnly });
  const bySource = loaded.error ? [] : summarizePayableBalanceBySource(loaded.grains, { pendingOnly });
  const byMonth = loaded.error || !pendingOnly
    ? []
    : summarizePayableBalanceByMonthAndSource(loaded.grains, { pendingOnly: true });
  const periodLabel = pendingOnly ? "All months · pending balances" : payableBalanceMonthLabel(period);

  return <AppShell active="Payable balance" pageCode={pageCode}>
    <div className="payable-balance-page">
      <PageHead
        eyebrow="Payments"
        title="Payable balance"
        subtitle="Read-only totals from People Payroll, Workforce payouts and Helpers. Expense and payment requests are excluded."
        action={<span className="status-pill">View only</span>}
      />

      <section className="panel payable-balance-filter" aria-label="Payable balance period">
        <div className="panel-body">
          <form method="get">
            <label htmlFor="payable-balance-period">
              Period
              <select className="select" defaultValue={period} id="payable-balance-period" name="period">
                <option value="all-pending">All months — pending only</option>
                {loaded.months.map((month) => <option key={month} value={month}>{payableBalanceMonthLabel(month)}</option>)}
              </select>
            </label>
            <button className="button secondary" type="submit">View</button>
            <p className="subtle">{pendingOnly
              ? "Fully settled records are excluded; every remaining person/location balance is consolidated below."
              : "Monthly totals include all payable records for the selected month, including fully settled records."}</p>
          </form>
        </div>
      </section>

      {loaded.error || !total
        ? <section className="panel message-panel error" role="alert">
          <div className="panel-body">
            <strong>Unable to load payable balances</strong>
            <p className="subtle">{loaded.error ?? "The consolidated totals are unavailable."}</p>
          </div>
        </section>
        : <>
          <div className="payable-balance-period-heading">
            <h2>{periodLabel}</h2>
            <span>{total.recordCount.toLocaleString("en-IN")} {pendingOnly ? "pending" : "payable"} record{total.recordCount === 1 ? "" : "s"}</span>
          </div>

          <section className="summary-grid payable-balance-metrics" aria-label="Payable balance totals">
            <article className="metric-card">
              <span>Grand total</span>
              <strong>{currency(total.grandTotal)}</strong>
              <small>Final net payable before settled payments</small>
            </article>
            <article className="metric-card">
              <span>Paid amount</span>
              <strong>{currency(total.actualPaidAmount)}</strong>
              <small>Actual settled payments recorded for these balances</small>
            </article>
            <article className="metric-card payable-balance-due">
              <span>Payable balance</span>
              <strong>{currency(total.payableBalance)}</strong>
              <small>Processing, failed and cancelled instructions remain payable</small>
            </article>
          </section>

          {total.overpaidAmount > 0
            ? <section className="panel message-panel warn">
              <div className="panel-body">
                <strong>{currency(total.overpaidAmount)} is above current payable targets</strong>
                <p className="subtle">It is retained in settled history but is not used to reduce another person&apos;s balance.</p>
              </div>
            </section>
            : null}

          <section className="panel payable-balance-table-panel">
            <div className="panel-head">
              <div>
                <h2>Source summary</h2>
                <p className="subtle">Only the three requested payroll and payout sources are included.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Source</th><th>Records</th><th>Grand total</th><th>Paid amount</th><th>Payable balance</th></tr></thead>
                <tbody>{bySource.map((row) => <tr key={row.source}>
                  <td><strong>{PAYABLE_BALANCE_SOURCE_LABELS[row.source]}</strong></td>
                  <td>{row.recordCount.toLocaleString("en-IN")}</td>
                  <td>{currency(row.grandTotal)}</td>
                  <td>{currency(row.actualPaidAmount)}</td>
                  <td className="payable-balance-value"><strong>{currency(row.payableBalance)}</strong></td>
                </tr>)}</tbody>
                <tfoot><tr><th>Total</th><th>{total.recordCount.toLocaleString("en-IN")}</th><th>{currency(total.grandTotal)}</th><th>{currency(total.actualPaidAmount)}</th><th>{currency(total.payableBalance)}</th></tr></tfoot>
              </table>
            </div>
          </section>

          {pendingOnly ? <section className="panel payable-balance-table-panel">
            <div className="panel-head">
              <div>
                <h2>Pending by month</h2>
                <p className="subtle">Months and sources with no payable balance are omitted from this detail.</p>
              </div>
            </div>
            {byMonth.length ? <div className="table-wrap">
              <table>
                <thead><tr><th>Month</th><th>Source</th><th>Pending records</th><th>Grand total</th><th>Paid amount</th><th>Payable balance</th></tr></thead>
                <tbody>{byMonth.map((row) => <tr key={`${row.month}-${row.source}`}>
                  <td><strong>{payableBalanceMonthLabel(row.month)}</strong></td>
                  <td>{PAYABLE_BALANCE_SOURCE_LABELS[row.source]}</td>
                  <td>{row.recordCount.toLocaleString("en-IN")}</td>
                  <td>{currency(row.grandTotal)}</td>
                  <td>{currency(row.actualPaidAmount)}</td>
                  <td className="payable-balance-value"><strong>{currency(row.payableBalance)}</strong></td>
                </tr>)}</tbody>
              </table>
            </div> : <div className="panel-body"><p className="empty-cell">No pending payable balance is available.</p></div>}
          </section> : null}
        </>}
    </div>
  </AppShell>;
}
