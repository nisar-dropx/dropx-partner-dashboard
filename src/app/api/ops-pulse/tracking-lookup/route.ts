import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { lookupTrackingId } from "@/lib/ops-pulse/tracking-lookup";

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

    const result = await lookupTrackingId({
      companyId,
      trackingId,
      locationScopeIds: authorization.locationScopeIds,
      hasAllLocationAccess: authorization.hasAllLocationAccess,
      stationHint
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to look up this tracking ID.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
