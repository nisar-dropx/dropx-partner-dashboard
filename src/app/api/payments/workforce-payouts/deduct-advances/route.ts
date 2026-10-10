import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CALCULATION_ATTEMPTS = 2;
const noStore = { "Cache-Control": "private, no-store" };

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
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

function identity(workforceId: string, stationId: string) {
  return `${workforceId.toLowerCase()}|${stationId.toLowerCase()}`;
}

async function payoutSnapshotHash(companyId: string, periodStart: string, periodEnd: string) {
  const result = await supabaseAdmin!.rpc("workforce_advance_recovery_snapshot_hash", {
    p_company_id: companyId,
    p_period_start: periodStart,
    p_period_end: periodEnd
  });
  if (result.error) throw new Error(result.error.message);
  return String(result.data ?? "");
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to deduct Workforce advances.", 401);
    const ops = currentAdminAccessSurface() === "ops";
    const payoutPageCode = ops ? "ops_workforce_payouts" : "workforce_payouts";
    const advancePageCode = ops ? "ops_workforce_advances" : "workforce_advances";
    if (!hasPermission(authorization, payoutPageCode, "edit") || !hasPermission(authorization, advancePageCode, "edit")) {
      return errorResponse("Edit access to both Workforce Payouts and Workforce Advance Register is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const periodStart = String(body?.periodStart ?? "");
    const periodEnd = String(body?.periodEnd ?? "");
    const sourceItems: unknown[] = Array.isArray(body?.items) ? body.items : [];
    if (!validDate(periodStart) || !validDate(periodEnd) || periodEnd < periodStart) {
      return errorResponse("Select a valid payout period.", 400);
    }
    if (!sourceItems.length) return errorResponse("Select at least one Workforce payout.", 400);
    if (sourceItems.length > 1000) return errorResponse("Apply advances to at most 1000 payouts at a time.", 400);
    const selected = sourceItems.map((source) => {
      const item = source as Record<string, unknown>;
      return { workforceId: String(item.workforceId ?? ""), stationId: String(item.stationId ?? "") };
    });
    if (selected.some((item) => !UUID.test(item.workforceId) || !UUID.test(item.stationId))) {
      return errorResponse("One or more selected payouts are invalid.", 400);
    }
    const selectedKeys = new Set(selected.map((item) => identity(item.workforceId, item.stationId)));
    if (selectedKeys.size !== selected.length || new Set(selected.map((item) => item.workforceId.toLowerCase())).size !== selected.length) {
      return errorResponse("Select each Workforce member only once per recovery batch.", 400);
    }

    for (let attempt = 0; attempt < MAX_CALCULATION_ATTEMPTS; attempt += 1) {
      const snapshotBefore = await payoutSnapshotHash(companyId, periodStart, periodEnd);
      const loaded = await loadWorkforcePayoutRows(companyId, authorization, periodStart, periodEnd);
      if (loaded.error) return errorResponse(loaded.error, 400);
      const snapshotAfter = await payoutSnapshotHash(companyId, periodStart, periodEnd);
      if (!snapshotBefore || snapshotAfter !== snapshotBefore) continue;

      const payoutByIdentity = new Map(loaded.rows.flatMap((row) => row.reviewSubjectId && row.locationId
        ? [[identity(row.reviewSubjectId, row.locationId), row] as const]
        : []));
      const rpcItems = selected.map((item) => {
        const row = payoutByIdentity.get(identity(item.workforceId, item.stationId));
        if (!row || !row.paymentDetailsAvailable) throw new Error("A selected payout is no longer available. Refresh the page and try again.");
        const currentAdvance = row.deductionBreakdown
          .filter((line) => line.code.trim().toUpperCase() === "ADVANCE")
          .reduce((sum, line) => sum + Math.max(0, Number(line.amount) || 0), 0);
        const otherDeductions = Math.max(0, row.deductions - currentAdvance);
        const maxAmount = Math.max(0, Math.round((row.grossPayment - otherDeductions + Number.EPSILON) * 100) / 100);
        return { workforce_id: item.workforceId, station_id: item.stationId, max_amount: maxAmount, snapshot_hash: snapshotAfter };
      });
      const applied = await supabaseAdmin.rpc("workforce_apply_advance_recoveries", {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_items: rpcItems,
        p_allowed_location_ids: authorization.hasAllLocationAccess ? null : authorization.locationScopeIds
      });
      if (applied.error) {
        const changedDuringApply = /Payout inputs changed while advances were being (?:prepared|applied)/i.test(applied.error.message);
        if (changedDuringApply) continue;
        const conflict = /approved|paid|changed|outside|cannot be replaced|later advance deductions|recalculating this earlier period|processing/i.test(applied.error.message);
        return errorResponse(applied.error.message, conflict ? 409 : 400);
      }
      const results = Array.isArray(applied.data) ? applied.data : [];
      const deducted = results.reduce((sum, item) => sum + Math.max(0, Number(item?.deducted ?? 0)), 0);
      const publicationRefresh = await refreshWorkforcePayoutPublicationJobs({
        authorization,
        companyId,
        workforceIds: [...new Set(selected.map((item) => item.workforceId.toLowerCase()))],
        periodStart,
        periodEnd,
        limit: Math.min(100, selected.length)
      });
      return Response.json({
        updated: results.filter((item) => Number(item?.deducted ?? 0) > 0).length,
        deducted: Math.round((deducted + Number.EPSILON) * 100) / 100,
        selected: selected.length,
        publicationRefresh
      }, { headers: noStore });
    }
    return errorResponse("The selected payout period is still updating. Please try again in a moment.", 409);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to deduct pending advances.", 500);
  }
}
