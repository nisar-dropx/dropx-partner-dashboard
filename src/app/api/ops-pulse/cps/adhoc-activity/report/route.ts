import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { adHocClusterLabel, adHocDateRange, isAdHocActivityLocation, loadAdHocActivity } from "@/lib/ops-pulse/adhoc-activity";
import { sortAdHocStations, validAdHocSortDirection, validAdHocSortKey } from "@/lib/ops-pulse/adhoc-activity-sort";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
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
    return Response.json({ error: "CPS access is required." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }

  const companyId = requireCompanyId(authorization);
  const params = new URL(request.url).searchParams;
  const today = todayKolkata();
  const range = adHocDateRange({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    month: params.get("month") ?? undefined,
  }, today);
  const locationsResult = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess,
  );
  if (locationsResult.error) {
    return Response.json({ error: locationsResult.error }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }

  const allLocations = locationsResult.locations.filter(isAdHocActivityLocation);
  const clusters = [...new Set(allLocations.map(adHocClusterLabel))].sort((left, right) => left.localeCompare(right));
  const selectedClusters = new Set(listParam(params.get("clusters"), clusters));
  const clusterLocations = allLocations.filter((location) => selectedClusters.has(adHocClusterLabel(location)));
  const stationCodes = clusterLocations.map((location) => location.station_code);
  const selectedCodes = new Set(listParam(params.get("stations"), stationCodes));
  const selectedLocations = clusterLocations.filter((location) => selectedCodes.has(location.station_code));
  const activity = await loadAdHocActivity(companyId, selectedLocations, range.from, range.to);
  if (activity.error) {
    return Response.json({ error: activity.error }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }

  const sortKey = validAdHocSortKey(params.get("sort"));
  const direction = validAdHocSortDirection(params.get("direction"));
  const stations = sortAdHocStations(activity.stations, sortKey, direction);
  const stationRows = stations.map((station) => ({
    Station: station.code,
    "Station name": station.name,
    Cluster: station.cluster,
    Region: station.region,
    "Adhoc Van": station.vanCount,
    "Van amount": station.vanAmount,
    "Cashbook Van": station.cashbookVanCount,
    "Cashbook paid": station.cashbookVanAmount,
    "Adhoc DA": station.daCount,
    "DA amount": station.daAmount,
    "Total jobs": station.totalCount,
    "Total amount": station.totalAmount,
  }));
  const dailyRows = stations.flatMap((station) => station.days.map((day) => ({
    Date: day.date,
    Station: station.code,
    "Station name": station.name,
    Cluster: station.cluster,
    Region: station.region,
    "Adhoc Van": day.vanCount,
    "Van amount": day.vanAmount,
    "Cashbook Van": day.cashbookVanCount,
    "Cashbook paid": day.cashbookVanAmount,
    "Adhoc DA": day.daCount,
    "DA amount": day.daAmount,
    "Total jobs": day.totalCount,
    "Total amount": day.totalAmount,
  })));
  const detailRows = stations.flatMap((station) => station.days.flatMap((day) => day.entries.map((entry) => ({
    Date: day.date,
    Station: station.code,
    "Station name": station.name,
    Cluster: station.cluster,
    Region: station.region,
    Source: entry.source,
    Reference: entry.reference,
    Type: entry.category,
    Amount: entry.amount,
    Reason: entry.reason,
    Remark: entry.remark,
    "Included in job total": entry.countedInTotal ? "Yes" : "No — linked payment",
  }))));

  return workbookResponse([
    {
      name: "Overview",
      rows: [{
        From: range.from,
        To: range.to,
        "Selected stations": selectedLocations.length,
        "Location scope": "Head Office and Amazon Now excluded",
        "Active stations": activity.totals.activeStations,
        "Adhoc Van": activity.totals.vanCount,
        "Van amount": activity.totals.vanAmount,
        "Adhoc DA": activity.totals.daCount,
        "DA amount": activity.totals.daAmount,
        "Total jobs": activity.totals.totalCount,
        "Total amount": activity.totals.totalAmount,
        "Sorted by": sortKey,
        Direction: direction,
      }],
    },
    { name: "Station summary", rows: stationRows },
    { name: "Daily activity", rows: dailyRows },
    { name: "Reasons and remarks", rows: detailRows },
  ], `adhoc-van-da-${range.from}-to-${range.to}.xlsx`);
}
