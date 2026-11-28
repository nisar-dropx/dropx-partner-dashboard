import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { adHocClusterLabel, adHocDateRange, isAdHocActivityLocation } from "@/lib/ops-pulse/adhoc-activity";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { loadFixedPayDa } from "@/lib/ops-pulse/fixed-pay-da";
import {
  sortFixedPayDaStations,
  validFixedPayDaSortDirection,
  validFixedPayDaSortKey
} from "@/lib/ops-pulse/fixed-pay-da-sort";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function listParam(value: string | null, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  return allowed.filter((item) => requested.has(item));
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "cps_overview", "access")) {
    return Response.json(
      { error: "CPS access is required." },
      { status: 403, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const companyId = requireCompanyId(authorization);
  const params = new URL(request.url).searchParams;
  const today = todayKolkata();
  const range = adHocDateRange(
    {
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      month: params.get("month") ?? undefined
    },
    today
  );
  const locationsResult = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess
  );
  if (locationsResult.error) {
    return Response.json(
      { error: locationsResult.error },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const allLocations = locationsResult.locations.filter(isAdHocActivityLocation);
  const clusters = [...new Set(allLocations.map(adHocClusterLabel))].sort((left, right) =>
    left.localeCompare(right)
  );
  const selectedClusters = new Set(listParam(params.get("clusters"), clusters));
  const clusterLocations = allLocations.filter((location) =>
    selectedClusters.has(adHocClusterLabel(location))
  );
  const stationCodes = clusterLocations.map((location) => location.station_code);
  const selectedCodes = new Set(listParam(params.get("stations"), stationCodes));
  const selectedLocations = clusterLocations.filter((location) =>
    selectedCodes.has(location.station_code)
  );
  const activity = await loadFixedPayDa(companyId, selectedLocations, range.from, range.to);
  if (activity.error) {
    return Response.json(
      { error: activity.error },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const sortKey = validFixedPayDaSortKey(params.get("sort"));
  const direction = validFixedPayDaSortDirection(params.get("direction"));
  const stations = sortFixedPayDaStations(activity.stations, sortKey, direction);
  const stationRows = stations.map((station) => ({
    Station: station.code,
    "Station name": station.name,
    Cluster: station.cluster,
    Region: station.region,
    "Fixed-pay DAs": station.associates,
    "Worked days": station.workedDays,
    Deliveries: station.deliveries,
    "Customer returns": station.customerReturns,
    Shipments: station.shipments,
    "Fixed / MG": station.salary,
    "Fixed Pay DA CPS": station.cps,
    "Pending days": station.pendingDays
  }));
  const dailyRows = stations.flatMap((station) =>
    station.days.map((day) => ({
      Date: day.date,
      Station: station.code,
      "Station name": station.name,
      Cluster: station.cluster,
      "Fixed-pay DAs": day.associates,
      Deliveries: day.deliveries,
      "Customer returns": day.customerReturns,
      Shipments: day.shipments,
      "Fixed / MG": day.salary,
      "Fixed Pay DA CPS": day.cps,
      "Pending days": day.pendingDays
    }))
  );
  const associateRows = stations.flatMap((station) =>
    station.people.map((person) => ({
      Station: station.code,
      "Station name": station.name,
      Cluster: station.cluster,
      Associate: person.name,
      "DropX ID": person.dropxId,
      "Provider IDs": person.providerIds.join(", "),
      "Worked days": person.workDates.length,
      Deliveries: person.deliveries,
      "Customer returns": person.customerReturns,
      Shipments: person.shipments,
      "Fixed / MG": person.salary,
      "Pending days": person.pendingFixedDates.length
    }))
  );

  return workbookResponse({
    fileName: `fixed-pay-da-cps-${range.from}-to-${range.to}.xlsx`,
    sheets: [
      { name: "Station summary", rows: stationRows },
      { name: "Daily", rows: dailyRows },
      { name: "Associates", rows: associateRows }
    ]
  });
}
