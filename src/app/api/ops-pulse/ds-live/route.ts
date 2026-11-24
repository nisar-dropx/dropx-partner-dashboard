import { NextResponse } from "next/server";
import { requireDsLivePerformanceApi } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsLivePerformance, loadDsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(request: Request) {
  try {
    const gate = await requireDsLivePerformanceApi();
    if (gate.error) return gate.error;
    const { authorization } = gate;

    const url = new URL(request.url);
    const date = url.searchParams.get("date")?.trim() || undefined;
    const station = url.searchParams.get("station")?.trim().toUpperCase() || "";

    if (station) {
      const detail = await loadDsLiveStoreDetail(authorization, station, { businessDate: date });
      if (!detail) return NextResponse.json({ error: "Store not in scope." }, { status: 404 });
      return NextResponse.json({ detail });
    }

    const payload = await loadDsLivePerformance(authorization, { businessDate: date });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Dark Store live performance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
