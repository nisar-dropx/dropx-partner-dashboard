import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { loadReviewEddHistory } from "@/lib/ops-pulse/review-operations-data";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "performance_review", "access"))
    return Response.json({ error: "Review access required." }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  const date = params.get("date") || "", code = params.get("station") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date || !/^[A-Z0-9_-]{1,30}$/i.test(code))
    return Response.json({ error: "Choose a valid station and date." }, { status: 400, headers });
  try {
    const companyId = requireCompanyId(auth);
    const scope = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
    if (scope.error) return Response.json({ error: "Station access could not be verified." }, { status: 503, headers });
    const station = scope.locations.find(row => row.station_code === code);
    if (!station) return Response.json({ error: "Station access required." }, { status: 403, headers });
    const result = await loadReviewEddHistory(companyId, station.id, station.station_code, date);
    return Response.json(result, { status: result.error ? 503 : 200, headers });
  } catch {
    return Response.json({ error: "Delivery history could not be refreshed." }, { status: 503, headers });
  }
}
