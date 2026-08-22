import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const fromDate = url.searchParams.get("fromDate")?.trim() ?? "";
    const toDate = url.searchParams.get("toDate")?.trim() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await fetchEddStation({
      stationCode,
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {})
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the EDD dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
