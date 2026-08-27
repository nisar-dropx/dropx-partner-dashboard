import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddPerformanceNetwork } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Excel download of the network-wide Delivery Performance overview — one row per station. */
export async function GET() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const payload = await fetchEddPerformanceNetwork();
    const rows = payload.stations.map((station) => ({
      Station: station.stationCode,
      "Has Snapshot": station.hasSnapshot ? "Yes" : "No",
      "Fetched At": station.fetchedAt ?? "",
      Assigned: station.assigned,
      Delivered: station.delivered,
      Held: station.held,
      Returned: station.returned,
      "Yet to dispatch": station.yetToDispatch,
      "Delivery %": station.deliveredPct,
      "Returned %": station.returnedPct,
      "Held %": station.heldPct
    }));

    return workbookResponse([{ name: "Network overview", rows }], `performance-network-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Performance network report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
