import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { fetchLoadFlashNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const date = new URL(request.url).searchParams.get("date") ?? "";
    const payload = await fetchLoadFlashNetwork(date || undefined);
    // Same station scope as the page and the report: the open tab re-reads
    // this while a refresh runs, and must not widen what the viewer sees.
    const authorization = await getAuthorization();
    if (authorization?.companyId) {
      const companyId = requireCompanyId(authorization);
      const allowed = new Set((await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)).map((station) => station.code));
      payload.stations = payload.stations.filter((row) => allowed.has(row.stationCode));
    }
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the station load report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
