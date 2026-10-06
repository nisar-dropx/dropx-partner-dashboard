import { loadPnl } from "@/lib/finance/pnl-data";
import { comparisonOptions } from "@/lib/finance/pnl-comparison";
import { exportPnlCsv, exportPnlExcel, exportPnlPdf } from "@/lib/finance/pnl-export";
import { NextResponse } from "next/server";
import { financeContext, loadBusiness } from "@/lib/finance/data";
import { selectDailyRows } from "@/lib/finance/performance";
import { csvText } from "@/lib/finance/pricing";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const tab = query.tab === "pnl" ? "pnl" : "revenue";
  const context = await financeContext(
    tab === "pnl" ? "finance_pnl" : "finance_revenue",
  );
  try {
    if (query.tab === "pnl") {
      const r = await loadPnl(context, query);
      const options = comparisonOptions(query);
      const format = query.format || "csv";
      if (!["xlsx", "pdf", "csv"].includes(format)) throw Error("Choose Excel, PDF or CSV.");
      const body = format === "xlsx" ? await exportPnlExcel(r, options) : format === "pdf" ? await exportPnlPdf(r, options) : exportPnlCsv(r, options);
      return new NextResponse(typeof body === "string" ? body : new Uint8Array(body).buffer, { headers: {
        "Content-Type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="profit-loss-${options.view}-${r.filters.from}-to-${r.filters.to}.${format}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }

    const { rows, filters, readAt } = await loadBusiness(context, query);
    const daily = query.detail === "daily";
    const selected = selectDailyRows(
      rows,
      query.daily || "all",
      query.dailyClient,
    );
    if (daily && query.daily && query.daily !== "all" && !selected.length)
      throw new Error("No permitted allocation matches this daily breakup.");
    const caveat =
      "Management estimate only. Monthly MG and configured monthly fee are divided by the selected month's actual calendar days. Positive daily excess uses Amazon deliveries plus C-returns above the prorated MG volume, at the variable slab rate, plus MFN. The latest rate card effective on or before the selected month remains active until replaced. XPT uses its fixed payout plus all its Amazon deliveries and C-returns at the parent variable rate. SWA delivery earnings use the configured separate SWA rate; unpriced counts remain flagged. IHS/SMD settlement rules, recoveries, other fees and tax are excluded. Rent and maintenance come from effective Rent Master agreements and accrue by actual calendar days; remaining costs come from station reports. Blank or incomplete values do not produce P&L.";
    const dailyBody = daily
      ? csvText([
          [
            "Station",
            "Location",
            "Client",
            "Region",
            "Cluster",
            "Date",
            "Deliveries",
            "SWA deliveries",
            "C-returns",
            "MG billable volume",
            "Pricing model",
            "Parent station",
            "Parent rate revision",
            "Fixed payout pending",
            "Daily MG volume",
            "Excess volume",
            "MG revenue INR",
            "Excess/slab rate INR",
            "Excess/slab earnings INR",
            "MFN count",
            "MFN rate INR",
            "MFN earnings INR",
            "SWA earnings INR",
            "SMD count (included in deliveries)",
            "SMD rate INR (pending separate billing)",
            "IHS count",
            "IHS <15% rate INR (pending)",
            "IHS >15% rate INR (pending)",
            "Day revenue INR",
            ...(tab === "pnl"
              ? [
                  "Rent Master INR",
                  "Known operating costs INR",
                  "Cost complete",
                  "Day P&L INR",
                ]
              : []),
            "Shipment reported",
            "Rate revision",
            "Issues",
            "Read at",
            "Caveat",
          ],
          ...selected.flatMap((r) =>
            r.daily.map((d) => [
              r.station,
              r.name,
              r.provider,
              r.region,
              r.cluster,
              d.date,
              d.deliveries,
              d.swa,
              d.returns,
              d.eligibleDeliveries,
              r.model,
              r.parentStation,
              r.parentRateRevision,
              r.pendingFixed ? "Yes" : "No",
              d.mgVolume,
              d.excessVolume,
              d.base,
              r.variableRate,
              d.variable,
              d.mfn,
              r.mfnRate,
              d.mfnRevenue,
              d.swaRevenue ?? null,
              d.smd,
              r.smdRate,
              d.ihs,
              r.ihsLowRate,
              r.ihsHighRate,
              d.revenue,
              ...(tab === "pnl"
                ? [d.rentCost, d.cost, d.costComplete ? "Yes" : "No", d.profit]
                : []),
              d.shipmentReported ? "Yes" : "No",
              r.revision,
              d.issues.join("; "),
              readAt,
              caveat,
            ]),
          ),
        ])
      : null;
    const headings = [
      "Station",
      "Pricing model",
      "Parent station",
      "Parent variable rate",
      "Parent rate revision",
      "Fixed payout pending",
      "Location",
      "Client",
      "Region",
      "Cluster",
      "Month",
      "Through",
      "Deliveries",
      "SWA deliveries",
      "C-returns",
      "MG billable volume",
      "Monthly MG",
      "Monthly fee",
      "MG delivery volume",
      "Pricing effective month",
      "Rate revision",
      "MTD revenue estimate INR",
      ...(tab === "pnl"
        ? [
            "Known operating costs INR",
            "Cost complete",
            "Estimated P&L INR",
            "DA pay",
            "Staff",
            "Fuel",
            "Vehicle",
            "Rent",
            "Other",
            "UTR",
            "Van",
          ]
        : []),
      "Shipment days",
      "Cost days",
      "Shipment through",
      "Cost through",
      "Basis",
      "Issues",
      "Read at",
      "Caveat",
    ];
    const body =
      dailyBody ??
      csvText([
        headings,
        ...rows.map((r) => [
          r.station,
          r.model,
          r.parentStation,
          r.variableRate,
          r.parentRateRevision,
          r.pendingFixed ? "Yes" : "No",
          r.name,
          r.provider,
          r.region,
          r.cluster,
          filters.month,
          filters.through,
          r.deliveries,
          r.swaDeliveries,
          r.returns,
          r.eligibleDeliveries,
          r.mg,
          r.monthlyFee,
          r.mgVolume,
          r.pricingEffectiveMonth,
          r.revision,
          r.revenue,
          ...(tab === "pnl"
            ? [
                r.cost,
                r.costComplete ? "Yes" : "No",
                r.profit,
                ...(
                  [
                    "da",
                    "staff",
                    "fuel",
                    "vehicle",
                    "rent",
                    "other",
                    "utr",
                    "van",
                  ] as const
                ).map((k) => r.components?.[k] ?? null),
              ]
            : []),
          r.shipmentDays,
          r.costDays,
          r.shipmentThrough,
          r.costThrough,
          r.basis,
          r.issues.join("; "),
          readAt,
          caveat,
        ]),
      ]);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${tab === "pnl" ? "profit-loss" : "revenue-billing"}-${filters.month}${daily ? "-daily" : ""}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to export Finance data.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
