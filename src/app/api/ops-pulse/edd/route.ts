import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Fast cached read — see src/app/api/ops-pulse/edd/refresh for the live pull. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await fetchEddStation({ stationCode });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the EDD dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
