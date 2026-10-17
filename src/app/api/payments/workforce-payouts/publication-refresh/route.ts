import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";
import {
  ensureWorkforcePayoutPublicationRefreshJobs,
  MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS,
  type WorkforcePayoutPublicationSelfHealResult,
  type WorkforcePayoutPublicationSelfHealTarget
} from "@/lib/workforce-payout-publication-self-heal";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function response(payload: Record<string, unknown>, status = 200) {
  return Response.json(payload, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function completeCalendarMonth(periodStart: string, periodEnd: string) {
  if (!validDate(periodStart) || !validDate(periodEnd) || !periodStart.endsWith("-01")) return false;
  const end = new Date(`${periodStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10) === periodEnd;
}

function identity(target: WorkforcePayoutPublicationSelfHealTarget) {
  return `${target.workforceId.toLowerCase()}|${target.stationId.toLowerCase()}`;
}

function publicCounts(result: WorkforcePayoutPublicationSelfHealResult) {
  return {
    requested: result.requested,
    enqueued: result.enqueued,
    alreadyQueued: result.alreadyQueued,
    failed: result.failed,
    current: result.current,
    missingPublication: result.missingPublication,
    mappingUnlocked: result.mappingUnlocked
  };
}

function blocked(result: WorkforcePayoutPublicationSelfHealResult, expected: number) {
  return result.requested !== expected
    || result.failed > 0
    || result.missingPublication > 0
    || result.mappingUnlocked > 0;
}

function unresolved(result: WorkforcePayoutPublicationSelfHealResult, expected: number) {
  return blocked(result, expected)
    || result.current !== expected
    || result.enqueued > 0
    || result.alreadyQueued > 0;
}

function helperErrorStatus(message: string) {
  if (/configuration|database connection/i.test(message)) return 503;
  if (/invalid|at most|select at least|unique/i.test(message)) return 400;
  if (/updating|changed|outside|permitted|missing|duplicate|authoritative|setup|unavailable/i.test(message)) return 409;
  return 500;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return response({ error: "Invalid request origin." }, 403);
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return response({ error: "The publication refresh request is too large." }, 413);
    }

    const authorization = await getAuthorization();
    if (!authorization) return response({ error: "Sign in to refresh Workforce payouts." }, 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit")) {
      return response({ error: "Edit access to Workforce Payouts is required." }, 403);
    }
    if (!supabaseAdmin) return response({ error: "Database configuration is unavailable." }, 503);

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return response({ error: "The publication refresh request is invalid." }, 400);
    }
    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    if (!completeCalendarMonth(periodStart, periodEnd)) {
      return response({ error: "Publication self-healing requires one complete calendar month." }, 400);
    }
    const sourceRows = Array.isArray(body.rows) ? body.rows : [];
    if (!sourceRows.length || sourceRows.length > MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS) {
      return response({
        error: `Select between 1 and ${MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS.toLocaleString("en-US")} exact payout rows.`
      }, 400);
    }
    const targets = sourceRows.map((source) => {
      const row = source && typeof source === "object" ? source as Record<string, unknown> : {};
      return {
        workforceId: String(row.workforceId ?? "").trim().toLowerCase(),
        stationId: String(row.stationId ?? "").trim().toLowerCase()
      };
    });
    if (targets.some((target) => !UUID.test(target.workforceId) || !UUID.test(target.stationId))) {
      return response({ error: "One or more publication refresh rows are invalid." }, 400);
    }
    if (new Set(targets.map(identity)).size !== targets.length) {
      return response({ error: "Select each Workforce and location payout row only once." }, 400);
    }

    const companyId = requireCompanyId(authorization);
    let ensured: WorkforcePayoutPublicationSelfHealResult;
    try {
      ensured = await ensureWorkforcePayoutPublicationRefreshJobs({
        companyId,
        authorization,
        actorUserId: authorization.userId,
        periodStart,
        periodEnd,
        targets
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to prepare the publication refresh.";
      const status = helperErrorStatus(message);
      return response({ error: message, progress: false, retryable: status >= 500 }, status);
    }
    const initial = publicCounts(ensured);
    const hasRefreshWork = ensured.enqueued > 0 || ensured.alreadyQueued > 0;
    if (blocked(ensured, targets.length) && !hasRefreshWork) {
      return response({
        error: "One or more selected payout publications require review before automatic refresh.",
        progress: false,
        ensure: initial
      }, 409);
    }
    if (ensured.current === targets.length) {
      return response({ ok: true, progress: false, ensure: initial, verification: initial });
    }
    if (!hasRefreshWork) {
      return response({
        error: "One or more payout publications could not be queued for automatic refresh.",
        progress: false,
        ensure: initial
      }, 409);
    }

    const refresh = await refreshWorkforcePayoutPublicationJobs({
      authorization,
      companyId,
      payoutRows: targets,
      periodStart,
      periodEnd,
      deadlineAtMs: Date.now() + 240_000,
      limit: MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS
    });
    let verification: WorkforcePayoutPublicationSelfHealResult;
    try {
      verification = await ensureWorkforcePayoutPublicationRefreshJobs({
        companyId,
        authorization,
        actorUserId: authorization.userId,
        periodStart,
        periodEnd,
        targets
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify the publication refresh.";
      const status = helperErrorStatus(message);
      return response({
        error: message,
        progress: ensured.enqueued > 0 || refresh.completed > 0,
        retryable: status >= 500,
        ensure: initial,
        refresh
      }, status);
    }
    const progress = ensured.enqueued > 0 || refresh.completed > 0 || verification.enqueued > 0;
    const verified = publicCounts(verification);
    const refreshFailed = refresh.failed > 0 || refresh.retrying > 0 || refresh.staleClaims > 0;
    if (refreshFailed || unresolved(verification, targets.length)) {
      const retryable = verification.failed === 0
        && verification.missingPublication === 0
        && verification.mappingUnlocked === 0;
      return response({
        error: verification.failed > 0
          ? "One or more payout publication refresh jobs require operator review."
          : "One or more payout publications are still refreshing. No payment eligibility was changed.",
        progress,
        retryable,
        ensure: initial,
        refresh,
        verification: verified
      }, 409);
    }
    return response({ ok: true, progress, ensure: initial, refresh, verification: verified });
  } catch (error) {
    return response({
      error: error instanceof Error ? error.message : "Unable to refresh Workforce payout publications.",
      progress: false,
      retryable: true
    }, 500);
  }
}
