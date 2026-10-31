import { NextRequest, NextResponse } from "next/server";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCortexRouteDetail } from "@/lib/ops-pulse/cortex-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePagePermissionOrThrow("performance", "access");
    const companyId = requireCompanyId(auth);
    const { searchParams } = request.nextUrl;
    const stationId = searchParams.get("stationId") || "";
    const date = searchParams.get("date") || "";
    const itineraryId = searchParams.get("itineraryId") || "";
    if (!/^[a-f0-9-]{36}$/i.test(stationId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !itineraryId) {
      return NextResponse.json({ error: "Invalid station, date, or itinerary." }, { status: 400 });
    }
    const detail = await loadCortexRouteDetail({
      companyId,
      locationScopeIds: auth.locationScopeIds,
      hasAllLocationAccess: auth.hasAllLocationAccess,
      stationId,
      date,
      itineraryId,
    });
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cortex detail unavailable.";
    const status = /outside your approved/i.test(message) ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
