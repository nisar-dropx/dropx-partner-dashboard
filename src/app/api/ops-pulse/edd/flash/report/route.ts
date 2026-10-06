import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashNetwork, fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations, pickFlashStations } from "@/lib/ops-pulse/load-flash-access";
import { loadFlashReportFilename, loadFlashReportSheets, type LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS = new Set<LoadFlashReportKind>(["full", "load", "edd", "road", "delivered", "returns", "pickups"]);
/** `driver=none` asks for parcels Amazon has not attached to a driver. */
const NO_DRIVER = "none";

/**
 * Ops Live workbook. Every kind carries its tracking IDs with the driver, not
 * just station counts. `stations` (comma-separated) and `driver` follow the
 * cluster, station or driver the viewer has open; anything outside the
 * viewer's own stations is ignored.
 */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const requested = url.searchParams.get("report") ?? "full";
    const kind: LoadFlashReportKind = KINDS.has(requested as LoadFlashReportKind) ? (requested as LoadFlashReportKind) : "full";
    const viewer = await loadFlashViewerStations();
    const stations = pickFlashStations(viewer, url.searchParams.get("stations"));
    const allowed = new Set(stations.map((station) => station.code));
    const narrowed = stations.length < viewer.length;
    const driverParam = url.searchParams.get("driver");
    // A driver only makes sense inside one station; ignore it on wider exports.
    const driverId = driverParam != null && stations.length === 1 ? (driverParam === NO_DRIVER ? "" : driverParam.trim()) : undefined;

    const payload = await fetchLoadFlashNetwork(date || undefined);
    payload.stations = payload.stations.filter((row) => allowed.has(row.stationCode));
    const businessDate = payload.businessDate || date || undefined;
    const tracking = (await fetchLoadFlashTracking(businessDate, narrowed ? [...allowed] : undefined)).filter((row) => allowed.has(row.stationCode));

    const sheets = loadFlashReportSheets(payload, kind, tracking, {
      stationNames: Object.fromEntries(stations.map((station) => [station.code, station.name])),
      driverId
    });
    const scope = [stations.length === 1 ? stations[0].code : narrowed ? `${stations.length}-stations` : "", driverId === undefined ? "" : driverId || "no-driver"].filter(Boolean).join("-");
    return await compressedWorkbookResponse(sheets, loadFlashReportFilename(payload.businessDate || date || "report", kind, scope));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Ops Live report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
