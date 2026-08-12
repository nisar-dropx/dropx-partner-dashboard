import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { refreshCiaNetwork, refreshCiaStation } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const body = (await request.json().catch(() => ({}))) as { stationCode?: string };
    const stationCode = String(body.stationCode ?? "").trim().toUpperCase();

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
