import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { refreshAllEddNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Keeps the Amazon EDD stock cache moving even when nobody opens the dashboard. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "EDD stock refresh runs only on OpsPulse." });
  }
  try {
    return NextResponse.json({ status: "ok", run: await refreshAllEddNetwork() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start the EDD stock refresh." }, { status: 500 });
  }
}
