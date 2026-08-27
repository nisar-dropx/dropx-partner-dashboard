import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddPerformanceDaily, fetchEddPerformanceStation, type EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET_LABEL: Record<EddPerformancePackage["bucket"], string> = {
  delivered: "Delivered",
  returned: "Returned",
  held: "Held",
  yetToDispatch: "Yet to dispatch"
};

/** Excel download of one station's Delivery Performance — today's packages, a by-associate rollup, and the day-wise archive. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const [result, dailyRows] = await Promise.all([
      fetchEddPerformanceStation({ stationCode }),
      fetchEddPerformanceDaily({ stationCode, days: 90 })
    ]);
    if (result.status === "no_snapshot") {
      return NextResponse.json({ error: `No Performance snapshot yet for ${stationCode} — refresh the station first.` }, { status: 404 });
    }
    const payload = result.payload;

    const packageRows = payload.packages.map((pkg) => ({
      "Tracking ID": pkg.trackingId,
      State: pkg.state ?? "",
      Bucket: BUCKET_LABEL[pkg.bucket] ?? pkg.bucket,
      "Driver ID": pkg.driverId ?? "",
      "Driver / Store Name": pkg.driverName ?? "",
      "Is Store": pkg.isAccessPoint ? "Yes" : "No",
      "Payment Method": pkg.paymentMethod ?? "",
      City: pkg.city ?? "",
      "Order ID": pkg.orderingOrderId ?? ""
    }));

    const byAssociate = new Map<string, { name: string; isStore: boolean; assigned: number; delivered: number; returned: number; held: number }>();
    for (const pkg of payload.packages) {
      if (pkg.bucket === "yetToDispatch") continue;
      const key = pkg.driverId || pkg.driverName || `tid:${pkg.trackingId}`;
      const entry = byAssociate.get(key) ?? { name: pkg.driverName || pkg.driverId || "Unknown", isStore: pkg.isAccessPoint, assigned: 0, delivered: 0, returned: 0, held: 0 };
      entry.assigned += 1;
      if (pkg.bucket === "delivered") entry.delivered += 1;
      else if (pkg.bucket === "returned") entry.returned += 1;
      else entry.held += 1;
      byAssociate.set(key, entry);
    }
    const associateRows = [...byAssociate.values()]
      .sort((a, b) => b.assigned - a.assigned)
      .map((row) => ({
        "Driver / Store": row.name,
        Type: row.isStore ? "Store" : "Driver",
        Assigned: row.assigned,
        Delivered: row.delivered,
        Held: row.held,
        Returned: row.returned,
        "Delivery %": row.assigned > 0 ? Math.round((row.delivered / row.assigned) * 1000) / 10 : 0
      }));
    const yetToDispatchCount = payload.packages.filter((pkg) => pkg.bucket === "yetToDispatch").length;
    if (yetToDispatchCount) {
      associateRows.push({ "Driver / Store": "(Yet to dispatch — no driver/store yet)", Type: "—", Assigned: yetToDispatchCount, Delivered: 0, Held: 0, Returned: 0, "Delivery %": 0 });
    }

    const ledgerRows = dailyRows.map((row) => ({
      Date: row.date,
      Assigned: row.assigned,
      Delivered: row.delivered,
      Held: row.held,
      Returned: row.returned,
      "Yet to dispatch": row.yetToDispatch,
      "Delivery %": row.deliveredPct
    }));

    const filename = `performance-${stationCode}-${payload.window.from || new Date().toISOString().slice(0, 10)}.xlsx`;
    return workbookResponse(
      [
        { name: "Today's packages", rows: packageRows },
        { name: "By associate", rows: associateRows },
        { name: "Day-wise ledger", rows: ledgerRows }
      ],
      filename
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Performance report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
