import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { fetchCiaDailyLedger } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const date = new URL(request.url).searchParams.get("date")?.trim() ?? "";
    return NextResponse.json(await fetchCiaDailyLedger(date ? { date } : undefined));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load day-wise Cash In Associate ledger.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
