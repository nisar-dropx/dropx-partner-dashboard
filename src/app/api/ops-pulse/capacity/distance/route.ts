import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  try {
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth, "capacity_associates", "access"))
      return Response.json(
        { error: "Distance access denied." },
        { status: 403, headers },
      );
    const companyId = requireCompanyId(auth),
      id = new URL(request.url).searchParams.get("routeId") || "";
    if (!supabaseAdmin || !/^[a-f0-9-]{36}$/i.test(id))
      return Response.json(
        { error: "Route not found." },
        { status: 404, headers },
      );
    const scope = await loadCodLocations(
      companyId,
      auth.locationScopeIds,
      auth.hasAllLocationAccess,
    );
    if (scope.error) throw Error("Station access could not be verified.");
    const ids = scope.locations
      .filter(isAmazonEdspXptLocation)
      .map((s) => s.id);
    if (!ids.length)
      return Response.json(
        { error: "Route not found." },
        { status: 404, headers },
      );
    const result = await supabaseAdmin
      .from("workforce_route_distances")
      .select("route_geometry")
      .eq("company_id", companyId)
      .in("station_id", ids)
      .eq("id", id)
      .eq("status", "ready")
      .maybeSingle();
    if (result.error) throw Error("Route could not be loaded. Please retry.");
    const g = result.data?.route_geometry;
    if (!g)
      return Response.json(
        { error: "No map has been received for this day." },
        { status: 404, headers },
      );
    // Precise route data stays behind the same company and station permission as the register.
    // Never return packages, customer names, addresses or phone numbers.
    return Response.json(
      {
        geometry: {
          station: g.station,
          path: g.path,
          method: ["amazon_gps", "amazon_gps_roads"].includes(g.method)
            ? g.method
            : "scan_roads",
          stops: (g.stops || []).map((s: any) => ({
            point: s.point,
            firstScanAt: s.firstScanAt,
            scanCount: s.scanCount,
          })),
        },
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "Route could not be loaded. Please retry." },
      { status: 500, headers },
    );
  }
}
