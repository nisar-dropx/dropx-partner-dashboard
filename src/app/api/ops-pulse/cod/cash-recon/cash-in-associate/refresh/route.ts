import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { refreshCiaNetwork, refreshCiaStation } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const body = (await request.json().catch(() => ({}))) as { stationCode?: string };
    const stationCode = String(body.stationCode ?? "").trim().toUpperCase();

    // A location-scoped user can only trigger a refresh for their own
    // station(s) — the hidden "Refresh all stations" button in the UI is not
    // itself a security boundary, so this is enforced here too regardless of
    // whether the request came from that button or a direct API call.
    const authorization = await getAuthorization();
    if (authorization && !authorization.hasAllLocationAccess) {
      const companyId = requireCompanyId(authorization);
      if (!stationCode) {
        return NextResponse.json({ error: "A network-wide refresh requires unrestricted location access." }, { status: 403 });
      }
      const { locations } = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
      const allowed = locations.some((location) => String(location.station_code ?? "").trim().toUpperCase() === stationCode);
      if (!allowed) {
        return NextResponse.json({ error: "Station access denied." }, { status: 403 });
      }
    }

    if (stationCode) {
      const result = await refreshCiaStation(stationCode);
      return NextResponse.json(result, { status: result.snapshotStatus === "ok" ? 200 : 502 });
    }

    return NextResponse.json(await refreshCiaNetwork());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh Cash In Associate.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
