import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { stationEddDeliveryProgress, stationEddTotal } from "@/lib/ops-pulse/station-edd";
import { fetchEddPerformanceNetwork } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const [stations, payload] = await Promise.all([
      loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess),
      fetchEddPerformanceNetwork()
    ]);
    const byCode = new Map(payload.stations.map((row) => [row.stationCode, row]));
    const rows = stations.map((station) => {
      const row = byCode.get(station.code);
      return {
        "Station Code": station.code,
        "Station Name": station.name,
        "EDD Today": row ? stationEddTotal(row) : 0,
        "Current at Station EDD": row?.yetToDispatch ?? 0,
        "Assigned / Dispatched": row?.assigned ?? 0,
        Delivered: row?.delivered ?? 0,
        "On Road / Held": row?.held ?? 0,
        Returned: row?.returned ?? 0,
        "Delivery Progress %": row ? stationEddDeliveryProgress(row) : 0,
        "Last Refreshed": row?.fetchedAt ?? ""
      };
    });
    return workbookResponse([{ name: "Station EDD" , rows }], `station-edd-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the EDD report." }, { status: 500 });
  }
}
