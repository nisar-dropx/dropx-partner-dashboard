import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { lookupTrackingId } from "@/lib/ops-pulse/tracking-lookup";
import { fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";
import { BOARD_TID } from "@/lib/ops-pulse/station-board-tids";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const companyId = requireCompanyId(authorization);

    const url = new URL(request.url);
    const trackingId = url.searchParams.get("trackingId")?.trim() ?? "";
    if (!trackingId) return NextResponse.json({ error: "trackingId is required." }, { status: 400 });
    const stationHint = url.searchParams.get("stationCode")?.trim() ?? undefined;
    const businessDate = url.searchParams.get("date")?.trim() ?? "";
    if (businessDate && !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });
    }

    const result = await lookupTrackingId({
      companyId,
      trackingId,
      locationScopeIds: authorization.locationScopeIds,
      hasAllLocationAccess: authorization.hasAllLocationAccess,
      stationHint
    });
    if (result.status !== "not_found" || !stationHint || !businessDate) return NextResponse.json(result);

    // The live SCC package-detail endpoint can fail when the station session is
    // stale even though this exact TID is present in the saved board census.
    // Preserve the authorised snapshot as a useful, clearly-labelled fallback
    // instead of incorrectly claiming that the shipment does not exist.
    try {
      const stationCode = stationHint.trim().toUpperCase();
      const viewerStations = await loadFlashViewerStations();
      const station = viewerStations.find((row) => row.code === stationCode);
      if (!station) return NextResponse.json(result);
      const rows = await fetchLoadFlashTracking(businessDate, [stationCode], {
        buckets: [BOARD_TID.PENDING_TODAY, BOARD_TID.EDD],
      });
      const snapshot = rows.find((row) => row.stationCode === stationCode && row.trackingId === trackingId);
      if (!snapshot) return NextResponse.json(result);
      return NextResponse.json({
        status: "snapshot",
        trackingId,
        stationCode,
        stationName: station.name || null,
        packageStatus: snapshot.state || null,
        driverName: snapshot.driverName || null,
        driverId: snapshot.driverId || null,
        promisedDeliveryTime: snapshot.edd || null,
        sourceBucket: snapshot.bucket,
        message: "Found in the saved EDD board snapshot. Live Amazon SCC history is temporarily unavailable for this shipment.",
      });
    } catch {
      return NextResponse.json(result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to look up this tracking ID.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
