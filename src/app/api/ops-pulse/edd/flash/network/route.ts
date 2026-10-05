import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const date = new URL(request.url).searchParams.get("date") ?? "";
    const payload = await fetchLoadFlashNetwork(date || undefined);
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the station load report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
