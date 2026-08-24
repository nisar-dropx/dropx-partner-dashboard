import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Fast cached read used both for the page's own reload and the client-side sweep-progress poll. */
export async function GET() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const payload = await fetchEddNetwork();
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the EDD network overview.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
