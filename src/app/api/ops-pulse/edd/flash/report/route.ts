import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashNetwork, fetchLoadFlashTracking, type LoadFlashTrackingRow } from "@/lib/ops-pulse/edd-worker";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { loadFlashReportFilename, loadFlashReportSheets, type LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";
import { compressedWorkbookResponse, workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS = new Set<LoadFlashReportKind>(["full", "load", "edd", "road", "delivered", "returns", "pickups"]);

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const requested = url.searchParams.get("report") ?? "full";
    const kind: LoadFlashReportKind = KINDS.has(requested as LoadFlashReportKind) ? (requested as LoadFlashReportKind) : "full";
    const payload = await fetchLoadFlashNetwork(date || undefined);
    const authorization = await getAuthorization();
    if (authorization?.companyId) {
      const companyId = requireCompanyId(authorization);
      const allowed = new Set((await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)).map((station) => station.code));
      payload.stations = payload.stations.filter((row) => allowed.has(row.stationCode));
    }
    let tracking: LoadFlashTrackingRow[] = [];
    if (kind === "full") {
      const allowed = new Set(payload.stations.map((row) => row.stationCode));
      tracking = (await fetchLoadFlashTracking(payload.businessDate || date || undefined)).filter((row) => allowed.has(row.stationCode));
    }
    const sheets = loadFlashReportSheets(payload, kind, tracking);
    const filename = loadFlashReportFilename(payload.businessDate || date || "report", kind);
    if (kind === "full") return compressedWorkbookResponse(sheets, filename);
    return workbookResponse(sheets, filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Ops Live report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
