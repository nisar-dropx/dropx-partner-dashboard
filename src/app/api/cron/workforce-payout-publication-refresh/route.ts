import { NextResponse } from "next/server";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

const OPERATIONAL_FAILURE_WARNING_CODES = new Set([
  "claim_failed",
  "configuration_unavailable",
  "queue_status_failed"
]);

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const deadlineAtMs = Date.now() + (maxDuration - 60) * 1000;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshWorkforcePayoutPublicationJobs({ deadlineAtMs, limit: 100 });
    const hasOperationalFailure = result.warnings.some((warning) =>
      warning.code ? OPERATIONAL_FAILURE_WARNING_CODES.has(warning.code) : false
    );
    const stalledWithReadyWork = result.remainingReady > 0 && result.completed === 0;
    const degraded = hasOperationalFailure || stalledWithReadyWork;
    const log = {
      event: degraded ? "workforce_payout_publication_refresh_degraded" : "workforce_payout_publication_refresh_completed",
      durationMs: Date.now() - startedAtMs,
      claimed: result.claimed,
      claimRetries: result.claimRetries,
      completed: result.completed,
      published: result.published,
      retrying: result.retrying,
      failed: result.failed,
      staleClaims: result.staleClaims,
      queueStatusChecked: result.queueStatusChecked,
      remainingReady: result.remainingReady,
      remainingUnfinished: result.remainingUnfinished,
      warningCodes: result.warnings.map((warning) => warning.code ?? "unspecified"),
      warningCount: result.warnings.length,
      warnings: result.warnings
    };
    if (degraded || result.warnings.length) console.warn(JSON.stringify(log));
    else console.info(JSON.stringify(log));
    return NextResponse.json(
      { ...result, healthy: !degraded },
      { status: degraded ? 503 : 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh queued Workforce payout publications.";
    console.error(JSON.stringify({
      event: "workforce_payout_publication_refresh_failed",
      durationMs: Date.now() - startedAtMs,
      message
    }));
    return NextResponse.json({
      error: message
    }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
