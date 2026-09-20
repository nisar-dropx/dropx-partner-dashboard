import { NextResponse } from "next/server";
import { stationEddApiContext, isStationEddApiDenied } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { verifyEddBatch } from "@/lib/ops-pulse/edd-ledger";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stations = await loadEddStations(context.companyId,context.authorization.locationScopeIds,context.authorization.hasAllLocationAccess);
    const code = new URL(request.url).searchParams.get("stationCode")?.trim().toUpperCase();
    if (code && !stations.some(s=>s.code===code)) return NextResponse.json({error:"Station is outside your assigned scope."},{status:403});
    return NextResponse.json(await verifyEddBatch(code ? [code] : stations.map(s=>s.code)));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Verification failed." },{status:500}); }
}
