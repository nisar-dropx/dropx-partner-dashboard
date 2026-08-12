import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { fetchCiaStation } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const asOfDate = url.searchParams.get("asOfDate")?.trim() ?? "";
    const fromDate = url.searchParams.get("fromDate")?.trim() ?? "";
    const toDate = url.searchParams.get("toDate")?.trim() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await fetchCiaStation(stationCode, {
      ...(asOfDate ? { asOfDate } : {}),
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {})
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Cash In Associate station.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
