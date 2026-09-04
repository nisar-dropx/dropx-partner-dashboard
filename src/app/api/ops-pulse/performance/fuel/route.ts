import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { readTrendQuery } from "@/lib/ops-pulse/review-trends";
import { loadReviewFuel } from "@/lib/ops-pulse/review-fuel-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "performance_review", "access"))
    return Response.json(
      { error: "You do not have access to review fuel expenses." },
      { status: 403, headers },
    );
  let query;
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("group")) throw Error("Choose one station and date.");
    params.set("group", "cost");
    query = readTrendQuery(params);
  } catch {
    return Response.json(
      { error: "Choose a valid station and review date." },
      { status: 400, headers },
    );
  }
  try {
    const companyId = requireCompanyId(auth),
      scope = await loadCodLocations(
        companyId,
        auth.locationScopeIds,
        auth.hasAllLocationAccess,
      );
    if (scope.error) throw Error("Station access could not be verified.");
    const station = scope.locations.find(
      (row) => row.station_code === query.station,
    );
    if (!station)
      return Response.json(
        { error: "You do not have access to this station." },
        { status: 403, headers },
      );
    return Response.json(
      await loadReviewFuel(companyId, station.station_code, query.date),
      { headers },
    );
  } catch (error) {
    console.error("Review fuel load failed", {
      station: query.station,
      error: error instanceof Error ? error.message : "unknown",
    });
    return Response.json(
      { error: "Fuel expenses could not be loaded. Please retry." },
      { status: 503, headers },
    );
  }
}
