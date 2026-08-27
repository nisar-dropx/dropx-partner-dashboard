import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { fetchCiaNetwork } from "@/lib/ops-pulse/cash-recon-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Excel download of the network-wide Cash In Associate overview — one row per station. */
export async function GET() {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const payload = await fetchCiaNetwork();
    const rows = payload.stations.map((station) => ({
      Station: station.stationCode,
      Status: station.status,
      Error: station.error ?? "",
      "Fetched At": station.fetchedAt ?? "",
      "CIA Total": station.ciaTotal,
      "Cash At Station": station.cashAtStationTotal,
      "Ageing Total": station.ageingTotal,
      "Deposited Total": station.depositedTotal,
      "Pending Liability": station.pendingLiability,
      "Cleared In Window": station.clearedInWindow,
      "Cash Difference": station.cashDifference,
      Difference: station.difference,
      "Shipment Count": station.shipmentCount,
      "Pending Driver Count": station.pendingDriverCount,
      "Limited By Remittance Window": station.limitedByRemittanceWindow ? "Yes" : "No"
    }));

    return workbookResponse([{ name: "Network overview", rows }], `cia-network-${payload.asOfDate || new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Cash In Associate network report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
