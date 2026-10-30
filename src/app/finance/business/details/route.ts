import { NextResponse } from "next/server";
import { financeContext, loadRent } from "@/lib/finance/data";
import { locationModel } from '@/lib/finance/business-master';
import { pnlFilters, shipmentReportingLimit, reportedShipmentDays } from "@/lib/finance/pnl";
import { evidenceStations, buildPnlEvidence } from "@/lib/finance/pnl-evidence";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadFinanceCpsEvidence } from "@/lib/finance/cost-data";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  // Host, session, Finance P&L permission and company are checked before any salary read.
  const context = await financeContext("finance_pnl");
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  let filters, codes;
  const basis=query.basis==='operating'?'operating':'shipments';
  try {
    filters = pnlFilters({ ...query, period: "custom" });
    codes = evidenceStations(
      query.stations,
      context.locations
        .filter(
          (l) =>
            !l.hide_from_location_list &&
            !l.is_ho &&
            !/^HO(?:_|$)/i.test(l.station_code),
        )
        .map((l) => l.station_code),
    );
    if(basis==='operating'&&codes.some(code=>!context.locations.some(l=>l.station_code===code&&locationModel(l)==='NOW')))throw Error('Operating-unit detail is only available for Amazon Now stores.');
  } catch {
    return NextResponse.json(
      { error: "Choose valid dates and stations within your Finance access." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  try {
    const billingPeriods=Object.fromEntries(context.locations.filter(l=>l.billing_period).map(l=>[l.station_code,l.billing_period!]));
    const coverageCodes=[...new Set([...codes,...codes.flatMap(code=>{const parent=billingPeriods[code]?.prior_reporting_station;return parent&&context.locations.some(l=>l.station_code===parent)?[parent]:[];})])];
    const [data, rents, fuel, shipments] = await Promise.all([
      loadFinanceCpsEvidence(
        context.companyId,
        filters.from,
        filters.to,
        codes,
      ),
      loadRent({
        ...context,
        locations: context.locations.filter((l) =>
          codes.includes(l.station_code),
        ),
      }),
      readAllRows(
        context.db
          .from("cps_fuel_daily")
          .select(
            "id,station_code,transaction_date,vehicle_no,provider,transaction_id,product,litres,amount",
          )
          .eq("company_id", context.companyId)
          .in("station_code", codes)
          .gte("transaction_date", filters.from)
          .lte("transaction_date", filters.to)
          .order("transaction_date")
          .order("id"),
      ),
      basis === 'shipments' ? context.db.rpc('finance_pnl_revenue_snapshot', {
        p_company: context.companyId, p_from: filters.from, p_through: filters.to, p_station_codes: coverageCodes,
      }) : Promise.resolve({data:null,error:null}),
    ]);
    if (fuel.error) throw Error("Fuel transaction details unavailable");
    if (shipments.error) throw Error('Shipment coverage could not be verified');
    return NextResponse.json(
      buildPnlEvidence(
        data.report,
        data.evidence,
        rents,
        filters.from,
        filters.to,
        codes,
        fuel.data ?? [],
        basis,
        basis === 'shipments' ? reportedShipmentDays({limit:shipmentReportingLimit(filters.to),shipments:shipments.data?.daily_shipments??[],billingPeriods},filters.from,filters.to,new Set(codes)) : undefined,
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error(
      "Finance calculation details unavailable",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "Calculation details could not be loaded. Please retry." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
