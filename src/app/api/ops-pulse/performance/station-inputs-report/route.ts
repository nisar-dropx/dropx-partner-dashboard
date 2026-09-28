import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { formatTrendValue, readTrendQuery, trendDates } from "@/lib/ops-pulse/review-trends";
import { loadReviewTrends } from "@/lib/ops-pulse/review-trends-data";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "performance_review", "access")) return Response.json({ error: "You do not have access to review station inputs." }, { status: 403, headers });
  const url = new URL(request.url), days = Number(url.searchParams.get("days"));
  if (![7, 14].includes(days)) return Response.json({ error: "Choose a 7-day or 14-day report." }, { status: 400, headers });
  let query;
  try { query = readTrendQuery(new URLSearchParams({ station: url.searchParams.get("station") ?? "", date: url.searchParams.get("date") ?? "", group: "station" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid station input report." }, { status: 400, headers }); }
  const companyId = requireCompanyId(auth), scope = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
  if (scope.error) return Response.json({ error: "Station access could not be verified. Please retry." }, { status: 503, headers });
  const station = scope.locations.find((row) => row.station_code === query.station);
  if (!station) return Response.json({ error: "You do not have access to this station." }, { status: 403, headers });
  try {
    const trend = await loadReviewTrends(companyId, station, query.date, "station"), dates = trendDates(query.date, days);
    const series = new Map(trend.series.map((entry) => [entry.key, entry]));
    const point = (key: string, date: string) => series.get(key)?.points.find((entry) => entry.date === date)?.value ?? null;
    return workbookResponse([
      { name: "Vehicle timings", rows: dates.map((date) => ({ Date: date, "First vehicle arrival IST": formatTrendValue(point("arrival", date), "time"), "Last unloading complete IST": formatTrendValue(point("unloading", date), "time") })) },
      { name: "EMD at 12 p.m.", rows: dates.map((date) => ({ Date: date, "EMD at 12 p.m. (%)": point("emd", date) })) }
    ], `ops-pulse-station-inputs-${query.station}-${dates[0]}-to-${query.date}.xlsx`);
  } catch (error) {
    console.error("Station input report failed", { station: query.station, error: error instanceof Error ? error.message : "unknown" });
    return Response.json({ error: "The station input report could not be generated. Please retry." }, { status: 503, headers });
  }
}
