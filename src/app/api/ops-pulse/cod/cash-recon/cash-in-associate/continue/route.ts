import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { continueCiaSnapshot } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    // /continue doesn't just read progress - it CLAIMS AND PROCESSES the next
    // station in a network-wide refresh run (the one "Refresh all stations"
    // starts). A location-scoped user's own initialRefreshProgress is nulled
    // out server-side (see page.tsx) specifically so their client never sets
    // refreshActive=true and never auto-calls this endpoint in the first
    // place - this is the defense-in-depth backstop for a direct API call
    // bypassing that, matching the same scoping already enforced on
    // network/route.ts and refresh/route.ts.
    const authorization = await getAuthorization();
    if (authorization && !authorization.hasAllLocationAccess) {
      return NextResponse.json({ error: "A network-wide refresh requires unrestricted location access." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { runId?: string };
    const runId = String(body.runId ?? "").trim() || undefined;
    return NextResponse.json(await continueCiaSnapshot(runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to advance Cash In Associate refresh.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
