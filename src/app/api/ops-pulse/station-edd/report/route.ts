import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_BUCKET_LABEL, stationEddDeliveryProgress, stationEddTotal } from "@/lib/ops-pulse/station-edd";
import { fetchEddPerformanceStation, type EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function packageRow(pkg: EddPerformancePackage) {
  return {
    "Tracking ID": pkg.trackingId,
    "EDD Position": STATION_EDD_BUCKET_LABEL[pkg.bucket],
    "Latest State": pkg.state ?? "",
    "Driver ID": pkg.driverId ?? "",
    "Driver / Store Name": pkg.driverName ?? "",
    "Is Store": pkg.isAccessPoint ? "Yes" : "No",
    "Payment Method": pkg.paymentMethod ?? "",
    City: pkg.city ?? "",
    "Order ID": pkg.orderingOrderId ?? ""
  };
}

export async function GET(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stationCode = new URL(request.url).searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    const station = stations.find((entry) => entry.code === stationCode);
    if (!station) return NextResponse.json({ error: "Station is outside your assigned location scope." }, { status: 403 });

    const result = await fetchEddPerformanceStation({ stationCode });
    if (result.status === "no_snapshot") {
      return NextResponse.json({ error: `No EDD snapshot yet for ${stationCode}.` }, { status: 404 });
    }
    const payload = result.payload;
    const summary = [{
      "Station Code": stationCode,
      "Station Name": station.name,
      Date: payload.window.from,
      "EDD Today": stationEddTotal(payload),
      "Current at Station EDD": payload.yetToDispatch,
      "Assigned / Dispatched": payload.assigned,
      Delivered: payload.delivered,
      "On Road / Held": payload.held,
      Returned: payload.returned,
      "Delivery Progress %": stationEddDeliveryProgress(payload),
      "Last Refreshed": payload.fetchedAt
    }];
    const allRows = payload.packages.map(packageRow);
    const atStationRows = payload.packages.filter((pkg) => pkg.bucket === "yetToDispatch").map(packageRow);

    return workbookResponse(
      [
        { name: "Summary", rows: summary },
        { name: "At Station EDD", rows: atStationRows },
        { name: "All EDD TIDs", rows: allRows }
      ],
      `station-edd-${stationCode}-${payload.window.from || new Date().toISOString().slice(0, 10)}.xlsx`
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the station EDD report." }, { status: 500 });
  }
}
