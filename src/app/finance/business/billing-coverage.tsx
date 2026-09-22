import type { BusinessRow } from "@/lib/finance/performance";
import { addAmounts } from "@/lib/finance/pricing";
const money = (v: string | null) =>
  v === null
    ? "Pending"
    : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function BillingCoverage({ rows }: { rows: BusinessRow[] }) {
  const amazon = rows.filter((r) => r.provider === "Amazon");
  if (!amazon.length) return null;
  const xpts = amazon.filter((r) => r.model === "xpt");
  const sum = (
    selected: BusinessRow[],
    key: "base" | "variable" | "mfnRevenue",
  ) => money(addAmounts(selected.flatMap((r) => r.daily.map((d) => d[key]))));
  const items = [
    [
      "MG payout",
      "Monthly MG card and actual calendar days",
      `Calculated: ${sum(
        amazon.filter((r) => r.model !== "xpt"),
        "base",
      )}`,
      "Subject to any unconfirmed shortfall/recovery adjustments.",
    ],
    [
      "Variable payout",
      "Daily imported deliveries and Variable_Slab rate",
      `Calculated: ${sum(amazon, "variable")}`,
      "Parent: daily excess only. XPT: all its Amazon deliveries. SWA is separately priced and excluded. SMD eligibility and any IHS component need settlement rules to reconcile exactly.",
    ],
    [
      "XPT fixed payout",
      "Parent relationship and a monthly fixed-payout field",
      xpts.length
        ? `${xpts.filter((r) => r.pendingFixed).length} of ${xpts.length} fixed payouts pending`
        : "No XPT in this selection",
      "Enter the confirmed amount in Pricing Master. A blank is not treated as a zero payout.",
    ],
    [
      "MFN payout",
      "Imported MFN counts and MFN unit rate",
      `Calculated: ${sum(amazon, "mfnRevenue")}`,
      "XPT MFN needs a separate rule if its count is positive.",
    ],
    [
      "SWA rejects payout",
      "Rejected SWA count exists in the raw Amazon report",
      "Rate confirmation pending",
      "The invoice and raw reject count can imply a rate, but the confirmed billing rule is still needed before applying it.",
    ],
    [
      "SWA delivered prepaid payout",
      "Standard SWA and consumable delivery counts are available",
      "Prepaid split and confirmed rate missing",
      "The August invoice supports an inferred rate. The current import does not separate prepaid from COD, so a daily prepaid payout cannot yet be calculated. Consumable deliveries are a separate field, not a COD count.",
    ],
    [
      "SWA COD delivered payout",
      "Combined SWA delivery count is available",
      "COD split and confirmed rate missing",
      "The August invoice supports an inferred rate. Need the payment-type count mapping and confirmed rate; avoid charging the same delivery twice.",
    ],
    [
      "SWA fuel surcharge",
      "A separate amount appears in the August invoice",
      "Surcharge rule missing",
      "Need the effective fuel surcharge rate or percentage and the deliveries or payout to which it applies.",
    ],
    [
      "OBD incentive",
      "A separate amount appears in the August invoice",
      "Eligibility and incentive rate missing",
      "Need the eligible OBD count and rate, or an approved monthly adjustment. Do not infer it from total deliveries.",
    ],
    [
      "Fuel surcharge",
      "A separate amount appears in the August invoice",
      "Surcharge rule missing",
      "Need the effective rate, applicable payout components and any caps. Recorded fuel expenses are a different input.",
    ],
    [
      "Buyback incentive",
      "Buyback delivered field exists in the raw report",
      "Incentive rule / amount missing",
      "Need the incentive rate or approved monthly amount and eligibility conditions.",
    ],
    [
      "Package-loss chargeback",
      "No billing deduction feed is connected",
      "Debit adjustment missing",
      "Need the actual station/month chargeback or debit note. It cannot be inferred from delivery counts.",
    ],
    [
      "IHS / SMD and other card rates",
      "IHS/SMD counts and card rates are available",
      "Settlement rules pending",
      "Confirm the IHS 15% denominator and exact boundary, SMD treatment, recovery conditions and fee timing.",
    ],
    [
      "GST / invoice total",
      "The supplied KGQA invoices show 18% IGST",
      "Excluded from operating revenue / P&L",
      "This view estimates revenue before tax. GST and final debit adjustments belong in invoice reconciliation.",
    ],
  ];
  return (
    <section className="panel fin-daily">
      <details>
        <summary className="panel-head">
          <div>
            <h2>Invoice coverage & missing inputs</h2>
            <p className="subtle">
              Compare the calculation with the sample Amazon invoice. Open to
              see which line items need counts, rates or rules.
            </p>
          </div>
        </summary>
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>Invoice item</th>
                <th>Available data</th>
                <th>Current coverage</th>
                <th>What is still needed</th>
              </tr>
            </thead>
            <tbody>
              {items.map(([item, data, status, needed]) => (
                <tr key={item}>
                  <td>
                    <strong>{item}</strong>
                  </td>
                  <td>{data}</td>
                  <td>{status}</td>
                  <td>{needed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fin-footnote">
          Reference: supplied KGQA invoices for April and August 2026. Invoice
          amounts and inferred SWA rates have not been copied into monthly
          pricing. Revenue and P&L remain estimates until missing settlement
          items and expenses are entered.
        </p>
      </details>
    </section>
  );
}
