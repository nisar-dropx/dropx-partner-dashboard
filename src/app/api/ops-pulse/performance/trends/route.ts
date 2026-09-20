import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { readTrendQuery } from "@/lib/ops-pulse/review-trends";
import { loadReviewTrends } from "@/lib/ops-pulse/review-trends-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "performance_review", "access"))
    return Response.json(
      { error: "You do not have access to review trends." },
      { status: 403, headers },
    );
  let query;
  try {
    query = readTrendQuery(new URL(request.url).searchParams);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Invalid trend selection." },
      { status: 400, headers },
    );
  }
  const companyId = requireCompanyId(auth),
    scope = await loadCodLocations(
      companyId,
      auth.locationScopeIds,
      auth.hasAllLocationAccess,
    );
  if (scope.error)
    return Response.json(
      { error: "Station access could not be verified. Please retry." },
      { status: 503, headers },
    );
  const station = scope.locations.find(
    (row) => row.station_code === query.station,
  );
  if (!station)
    return Response.json(
      { error: "You do not have access to this station." },
      { status: 403, headers },
    );
  try {
    return Response.json(
      await loadReviewTrends(companyId, station, query.date, query.group),
      { headers },
    );
  } catch (error) {
    console.error("Review trend load failed", {
      station: station.station_code,
      group: query.group,
      error: error instanceof Error ? error.message : "unknown",
    });
    return Response.json(
      { error: "Trend data could not be loaded. Please retry." },
      { status: 503, headers },
    );
  }
}
