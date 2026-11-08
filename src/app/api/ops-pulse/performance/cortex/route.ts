import { NextRequest, NextResponse } from "next/server";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCortexGpsTrail, loadCortexRouteDetail } from "@/lib/ops-pulse/cortex-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePagePermissionOrThrow("performance", "access");
    const companyId = requireCompanyId(auth);
    const { searchParams } = request.nextUrl;
    const stationId = searchParams.get("stationId") || "";
    const date = searchParams.get("date") || "";
    const itineraryId = searchParams.get("itineraryId") || "";
    const view = searchParams.get("view") || "detail";
    if (!/^[a-f0-9-]{36}$/i.test(stationId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !itineraryId) {
      return NextResponse.json({ error: "Invalid station, date, or itinerary." }, { status: 400 });
    }
    const common = {
      companyId,
      locationScopeIds: auth.locationScopeIds,
      hasAllLocationAccess: auth.hasAllLocationAccess,
      stationId,
      date,
      itineraryId,
    };
    if (view === "trail") {
      const transporterId = searchParams.get("transporterId") || "";
      if (!transporterId || transporterId.length > 500) {
        return NextResponse.json({ error: "Invalid transporter." }, { status: 400 });
      }
      const trail = await loadCortexGpsTrail({ ...common, transporterId });
      return NextResponse.json(trail, {
        headers: { "Cache-Control": "private, max-age=20, stale-while-revalidate=40" },
      });
    }
    const detail = await loadCortexRouteDetail({ ...common, includeGpsTrail: false });
    return NextResponse.json(detail, {
      headers: { "Cache-Control": "private, max-age=15, stale-while-revalidate=30" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cortex detail unavailable.";
    const status = /outside your approved/i.test(message) ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
