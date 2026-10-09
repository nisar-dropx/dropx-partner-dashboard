import { getAuthorization, hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const noStore = { "Cache-Control": "private, no-store" };
const MAX_CALCULATION_ATTEMPTS = 2;

type EligiblePayoutRpcRow = {
  dropx_id?: unknown;
  workforce_id?: unknown;
  payout_engine?: unknown;
  station_id?: unknown;
};

type ConfigureRecoveryArgs = {
  companyId: string;
  caseId: string;
  method: string;
  payoutMonth: string;
  dropxIds: string[];
  workforceItems: Array<Record<string, unknown>>;
  authorization: AuthorizationContext;
  companyWide: boolean;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function normalizeDropxId(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function periodEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function payoutIdentity(workforceId: unknown, locationId: unknown) {
  return `${String(workforceId ?? "").toLowerCase()}|${String(locationId ?? "").toLowerCase()}`;
}

async function payoutSnapshotHash(companyId: string, periodStart: string, endDate: string) {
  const result = await supabaseAdmin!.rpc("workforce_advance_recovery_snapshot_hash", {
    p_company_id: companyId,
    p_period_start: periodStart,
    p_period_end: endDate
  });
  if (result.error) throw new Error(result.error.message);
  return String(result.data ?? "");
}

async function workforceAvailability(
  companyId: string,
  authorization: AuthorizationContext,
  payoutMonth: string,
  candidates: EligiblePayoutRpcRow[]
) {
  if (!candidates.length) return [];
  const workforceIds = [...new Set(candidates.map((candidate) => String(candidate.workforce_id ?? "")).filter(Boolean))];
  const startDate = `${payoutMonth}-01`;
  const endDate = periodEnd(payoutMonth);

  for (let attempt = 0; attempt < MAX_CALCULATION_ATTEMPTS; attempt += 1) {
    const snapshotBefore = await payoutSnapshotHash(companyId, startDate, endDate);
    const loaded = await loadWorkforcePayoutRows(companyId, authorization, startDate, endDate, { workforceIds });
    if (loaded.error) throw new Error(loaded.error);
    const snapshotAfter = await payoutSnapshotHash(companyId, startDate, endDate);
    if (!snapshotBefore || snapshotBefore !== snapshotAfter) continue;

    const payoutByIdentity = new Map(loaded.rows.flatMap((row) => row.reviewSubjectId && row.locationId
      ? [[payoutIdentity(row.reviewSubjectId, row.locationId), row] as const]
      : []));
    return candidates.map((candidate) => {
      const workforceId = String(candidate.workforce_id ?? "");
      const stationId = String(candidate.station_id ?? "");
      const payout = payoutByIdentity.get(payoutIdentity(workforceId, stationId));
      const maxAmount = Math.max(0, Math.round(((Number(payout?.netAmount ?? 0) || 0) + Number.EPSILON) * 100) / 100);
      if (!payout?.paymentDetailsAvailable || payout.status !== "Ready for review" || maxAmount <= 0) {
        throw new Error(`DropX ID ${normalizeDropxId(candidate.dropx_id)} has no complete, available Workforce payout in ${payoutMonth}.`);
      }
      return {
        dropx_id: normalizeDropxId(candidate.dropx_id),
        workforce_id: workforceId,
        station_id: stationId,
        max_amount: maxAmount,
        snapshot_hash: snapshotAfter
      };
    });
  }
  throw new Error("Workforce payout inputs are still updating. Refresh and try again.");
}

async function recoveryIsConfigured(companyId: string, caseId: string) {
  const state = await supabaseAdmin!
    .from("payment_recovery_cases")
    .select("recovery_method")
    .eq("company_id", companyId)
    .eq("id", caseId)
    .maybeSingle();
  if (state.error) throw new Error("Unable to check the Recovery configuration state.");
  return Boolean(state.data?.recovery_method);
}

async function configureRecovery(args: ConfigureRecoveryArgs) {
  return supabaseAdmin!.rpc("payment_recovery_configure_case", {
    p_company_id: args.companyId,
    p_recovery_case_id: args.caseId,
    p_recovery_method: args.method,
    p_payout_month: args.method === "payout_deduction" ? `${args.payoutMonth}-01` : null,
    p_dropx_ids: args.method === "payout_deduction" ? args.dropxIds : [],
    p_workforce_items: args.workforceItems,
    p_actor_user_id: args.authorization.userId,
    p_allowed_location_ids: args.companyWide ? null : args.authorization.locationScopeIds
  });
}

function configurationResponse(
  applied: Awaited<ReturnType<typeof configureRecovery>>,
  method: string,
  dropxIds: string[]
) {
  if (applied.error) {
    const message = applied.error.message;
    const status = /not found/i.test(message)
      ? 404
      : /already configured|cannot be changed|changed|locked|processed|processing|paid|approved|outside|not eligible|does not have|matches more than one/i.test(message)
        ? 409
        : 400;
    return errorResponse(message, status);
  }

  const result = applied.data && typeof applied.data === "object"
    ? applied.data as Record<string, unknown>
    : {};
  return Response.json({
    ...result,
    message: method === "payout_deduction"
      ? `Recovery was deducted from ${dropxIds.length} ${dropxIds.length === 1 ? "payout" : "payouts"}.`
      : "Post-invoice provider dispute was selected for this TID."
  }, { headers: noStore });
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to configure payment recoveries.", 401);
    if (!hasPermission(authorization, "payment_recoveries", "edit")) {
      return errorResponse("Edit access to Payment Recovery is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const caseId = String(body?.caseId ?? "").trim();
    const method = String(body?.method ?? "").trim().toLowerCase();
    const payoutMonth = String(body?.payoutMonth ?? "").trim();
    const requestedIds: unknown[] = Array.isArray(body?.dropxIds) ? body.dropxIds : [];
    const dropxIds = [...new Set(requestedIds.map(normalizeDropxId).filter(Boolean))];

    if (!UUID_PATTERN.test(caseId)) return errorResponse("Select a valid recovery case.", 400);
    if (method !== "payout_deduction" && method !== "post_invoice_dispute") {
      return errorResponse("Select a valid recovery method.", 400);
    }
    if (method === "payout_deduction") {
      if (!MONTH_PATTERN.test(payoutMonth)) return errorResponse("Select a valid payroll month.", 400);
      if (!dropxIds.length) return errorResponse("Select at least one eligible DropX ID.", 400);
      if (dropxIds.length > 50) return errorResponse("Select at most 50 DropX IDs for one TID.", 400);
    } else if (payoutMonth || dropxIds.length) {
      return errorResponse("A post-invoice provider dispute must not include a payroll month or DropX IDs.", 400);
    }

    const companyWide = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const applyAndRespond = async (workforceItems: Array<Record<string, unknown>>) => configurationResponse(
      await configureRecovery({
        companyId,
        caseId,
        method,
        payoutMonth,
        dropxIds,
        workforceItems,
        authorization,
        companyWide
      }),
      method,
      dropxIds
    );
    const replayIfConfigured = async () => await recoveryIsConfigured(companyId, caseId)
      ? applyAndRespond([])
      : null;

    // A browser retry after a successful commit must reach the database RPC's
    // idempotent replay branch even though the payout amount has since changed.
    if (await recoveryIsConfigured(companyId, caseId)) return applyAndRespond([]);

    let workforceItems: Array<Record<string, unknown>> = [];
    if (method === "payout_deduction") {
      const eligible = await readAllRows(
        supabaseAdmin.rpc("payment_recovery_eligible_payout_targets", {
          p_company_id: companyId,
          p_payout_month: `${payoutMonth}-01`,
          p_allowed_location_ids: companyWide ? null : authorization.locationScopeIds
        })
          .order("dropx_id")
          .order("target_type")
          .order("target_id")
      );
      if (eligible.error) {
        const replay = await replayIfConfigured();
        return replay ?? errorResponse(eligible.error.message, 400);
      }
      const selected = ((eligible.data ?? []) as EligiblePayoutRpcRow[])
        .filter((candidate) => dropxIds.includes(normalizeDropxId(candidate.dropx_id)));
      const selectedCounts = new Map<string, number>();
      selected.forEach((candidate) => {
        const dropxId = normalizeDropxId(candidate.dropx_id);
        selectedCounts.set(dropxId, (selectedCounts.get(dropxId) ?? 0) + 1);
      });
      if (dropxIds.some((dropxId) => selectedCounts.get(dropxId) !== 1)) {
        const replay = await replayIfConfigured();
        return replay ?? errorResponse("One or more selected DropX IDs no longer have one exact-month payout row. Refresh and try again.", 409);
      }

      const payoutAuthorization = companyWide && !authorization.hasAllLocationAccess
        ? { ...authorization, hasAllLocationAccess: true }
        : authorization;
      try {
        workforceItems = await workforceAvailability(
          companyId,
          payoutAuthorization,
          payoutMonth,
          selected.filter((candidate) => String(candidate.payout_engine ?? "").toLowerCase() === "workforce")
        );
      } catch (error) {
        const replay = await replayIfConfigured();
        return replay ?? errorResponse(error instanceof Error ? error.message : "Unable to validate Workforce payout availability.", 409);
      }
    }
    return applyAndRespond(workforceItems);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to configure the payment recovery.", 500);
  }
}
