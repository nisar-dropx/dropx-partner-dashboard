import type { BusinessRow } from "@/lib/finance/performance";
import { addAmounts, addQuantities } from "@/lib/finance/pricing";
const money = (v: string | null) =>
  v === null
    ? "Pending"
    : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quantity = (v: string | null) =>
  v === null
    ? "—"
    : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 4 });
export function DailyBreakup({
  rows,
  pnl,
  download,
  close,
}: {
  rows: BusinessRow[];
  pnl: boolean;
  download: string;
  close: string;
}) {
  const one = rows.length === 1 ? rows[0] : null;
  const dates = [
    ...new Set(rows.flatMap((r) => r.daily.map((d) => d.date))),
  ].sort();
  const entries = dates.map((date) => {
    const days = rows.flatMap((r) => r.daily.filter((d) => d.date === date));
    const sum = (
      key:
        | "deliveries"
        | "eligibleDeliveries"
        | "returns"
        | "swa"
        | "mgVolume"
        | "excessVolume"
        | "base"
        | "variable"
        | "mfn"
        | "mfnRevenue"
        | "smd"
        | "ihs"
        | "revenue"
        | "rentCost"
        | "cost"
        | "profit",
    ) =>
      [
        "deliveries",
        "eligibleDeliveries",
        "returns",
        "swa",
        "mgVolume",
        "excessVolume",
        "mfn",
        "smd",
        "ihs",
      ].includes(key)
        ? addQuantities(days.map((d) => d[key]))
        : addAmounts(days.map((d) => d[key]));
    return {
      date,
      days,
      sum,
      issues: [...new Set(days.flatMap((d) => d.issues))],
      costComplete: days.every((day) => day.costComplete),
    };
  });
  return (
    <section className="panel fin-daily" id="daily-breakup">
      <div className="panel-head">
        <div>
          <h2>
            Daily breakup ·{" "}
            {one
              ? `${one.station} · ${one.model === "xpt" ? "XPT" : one.provider}`
              : rows.length <= 4
                ? rows.map((r) => r.station).join(" + ")
                : "Selected allocations"}
          </h2>
          <p className="subtle">
            MTD revenue {money(addAmounts(rows.map((r) => r.revenue)))} ·{" "}
            {rows.length} allocation{rows.length === 1 ? "" : "s"}. Daily
            revenue reconciles to MTD; rounding differences are carried between
            days.
          </p>
        </div>
        <div className="fin-actions">
          <a className="button" href={download}>
            Download daily CSV
          </a>
          <a className="button ghost" href={close}>
            Back to MTD
          </a>
        </div>
      </div>
      {one?.provider === "Amazon" && (
        <div className="fin-daily-rates">
          <span>
            {one.model === "xpt" ? "Monthly XPT fixed payout:" : "Monthly MG:"}{" "}
            <strong>{money(one.mg)}</strong>
          </span>
          <span>
            Monthly MG volume: <strong>{quantity(one.mgVolume)}</strong>
          </span>
          <span>
            Monthly fee: <strong>{money(one.monthlyFee)}</strong>
          </span>
          <span>
            Rate effective:{" "}
            <strong>
              {one.pricingEffectiveMonth?.slice(0, 7) ?? "Pending"}
            </strong>
          </span>
          <span>
            {one.model === "xpt"
              ? "Parent delivery rate:"
              : "Excess-delivery rate:"}{" "}
            <strong>{money(one.variableRate)}</strong>
          </span>
          <span>
            MFN rate: <strong>{money(one.mfnRate)}</strong>
          </span>
          <span>
            SMD rate: <strong>{money(one.smdRate)}</strong>
          </span>
          <span>
            IHS rates:{" "}
            <strong>
              {money(one.ihsLowRate)} / {money(one.ihsHighRate)}
            </strong>
          </span>
        </div>
      )}
      {one?.model === "xpt" && (
        <p className="fin-notice">
          Parent {one.parentStation} · Variable rate {money(one.variableRate)} ·
          Parent rate revision {one.parentRateRevision ?? "Not supplied"}.
          {one.pendingFixed
            ? " Fixed payout is blank; MTD shows known variable earnings only."
            : " Fixed payout included."}
        </p>
      )}
      <div className="fin-notice">
        SWA has separate pricing and is excluded from the calculation until its
        rates are supplied. XPT revenue is fixed payout divided by calendar days
        plus all XPT Amazon deliveries and C-returns at the parent’s variable
        rate. Parent MG
        excess delivery earnings use Amazon deliveries plus C-returns and are
        calculated separately for each day, with no negative excess or
        carry-forward between days. MG volume keeps its full precision. MFN is
        a separate pickup count. IHS quantities and SMD rates are shown for
        review; IHS earnings and any separate SMD adjustment await the billing
        rules. Flipkart daily earnings are changes in its cumulative monthly slab
        amount.
      </div>
      <div className="fin-table-wrap">
        <table className="fin-table fin-daily-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>All deliveries</th>
              <th>SWA (unpriced)</th>
              <th>C-returns</th>
              <th>MG billable volume</th>
              <th>Daily MG volume</th>
              <th>Variable billable volume</th>
              <th>MG / XPT fixed revenue</th>
              <th>Variable / slab earnings</th>
              <th>MFN count</th>
              <th>MFN earnings</th>
              <th>SMD / IHS counts</th>
              <th>Day revenue</th>
              {pnl && (
                <>
                  <th>Rent Master</th>
                  <th>Known operating costs</th>
                  <th>Day P&L</th>
                </>
              )}
              <th>Report coverage</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ date, days, sum, issues, costComplete }) => (
              <tr key={date}>
                <td>
                  <strong>{date}</strong>
                </td>
                <td>{quantity(sum("deliveries"))}</td>
                <td>{quantity(sum("swa"))}</td>
                <td>{quantity(sum("returns"))}</td>
                <td>{quantity(sum("eligibleDeliveries"))}</td>
                <td>
                  {one
                    ? quantity(days[0]?.mgVolume ?? null)
                    : quantity(sum("mgVolume"))}
                </td>
                <td>{quantity(sum("excessVolume"))}</td>
                <td>{money(sum("base"))}</td>
                <td>{money(sum("variable"))}</td>
                <td>{quantity(sum("mfn"))}</td>
                <td>{money(sum("mfnRevenue"))}</td>
                <td>
                  {quantity(sum("smd"))} / {quantity(sum("ihs"))}
                </td>
                <td>
                  <strong>{money(sum("revenue"))}</strong>
                </td>
                {pnl && (
                  <>
                    <td>{money(sum("rentCost"))}</td>
                    <td>{money(sum("cost"))}</td>
                    <td>{money(costComplete ? sum("profit") : null)}</td>
                  </>
                )}
                <td>
                  <details className="fin-row-details">
                    <summary>
                      {days.filter((d) => d.shipmentReported).length}/
                      {days.length} shipment reports
                      <small>
                        {issues.length ? "Pending items" : "Reported"}
                      </small>
                    </summary>
                    {issues.length ? (
                      <ul>
                        {issues.map((i) => (
                          <li key={i}>{i}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>Shipment and cost reports available.</p>
                    )}
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={7}>MTD total</th>
              <th>
                {money(
                  addAmounts(rows.flatMap((r) => r.daily.map((d) => d.base))),
                )}
              </th>
              <th>
                {money(
                  addAmounts(
                    rows.flatMap((r) => r.daily.map((d) => d.variable)),
                  ),
                )}
              </th>
              <th></th>
              <th>
                {money(
                  addAmounts(
                    rows.flatMap((r) => r.daily.map((d) => d.mfnRevenue)),
                  ),
                )}
              </th>
              <th></th>
              <th>{money(addAmounts(rows.map((r) => r.revenue)))}</th>
              {pnl && (
                <>
                  <th>
                    {money(
                      addAmounts(
                        rows.flatMap((r) => r.daily.map((d) => d.rentCost)),
                      ),
                    )}
                  </th>
                  <th>{money(addAmounts(rows.map((r) => r.cost)))}</th>
                  <th>
                    {money(
                      rows.every((r) => r.profit !== null)
                        ? addAmounts(rows.map((r) => r.profit))
                        : null,
                    )}
                  </th>
                </>
              )}
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="fin-footnote">
        Pending variable earnings are excluded from the current estimate. MG
        accrues on all elapsed calendar days. Missing reports are not treated as
        zero shipments or zero expenses.
      </p>
    </section>
  );
}
