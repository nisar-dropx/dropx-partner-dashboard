import { NextResponse } from "next/server";
import { financeContext, loadBusiness } from "@/lib/finance/data";
import { csvText } from "@/lib/finance/pricing";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const tab = query.tab === "pnl" ? "pnl" : "revenue";
  const context = await financeContext(
    tab === "pnl" ? "finance_pnl" : "finance_revenue",
  );
  try {
    const { rows, filters, readAt } = await loadBusiness(context, query);
    const headings = [
      "Station",
      "Location",
      "Client",
      "Region",
      "Cluster",
      "Month",
      "Through",
      "Deliveries",
      "Monthly MG",
      "MG delivery volume",
      "Rate revision",
      "Revenue estimate INR",
      ...(tab === "pnl"
        ? [
            "Recorded costs INR",
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
    const body = csvText([
      headings,
      ...rows.map((r) => [
        r.station,
        r.name,
        r.provider,
        r.region,
        r.cluster,
        filters.month,
        filters.through,
        r.deliveries,
        r.mg,
        r.mgVolume,
        r.revision,
        r.revenue,
        ...(tab === "pnl"
          ? [
              r.cost,
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
        "Management estimate only. Amazon MG is prorated by calendar days, before eligibility, variable revenue, recoveries, fees and tax. Costs are imported operating costs only. Blank values are unavailable.",
      ]),
    ]);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${tab === "pnl" ? "profit-loss" : "revenue-billing"}-${filters.month}.csv"`,
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
