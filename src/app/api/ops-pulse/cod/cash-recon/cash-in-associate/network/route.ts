import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { fetchCiaNetwork } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;
    return NextResponse.json(await fetchCiaNetwork());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Cash In Associate network.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
