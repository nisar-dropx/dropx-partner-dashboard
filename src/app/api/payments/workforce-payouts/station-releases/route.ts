import { revalidatePath } from "next/cache";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertStationScope } from "@/lib/workforce-payout-station-finance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function audienceValue(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "workforce" || normalized === "helpers" ? normalized : null;
}

function completeMonth(periodStart: string, periodEnd: string) {
  if (!DATE.test(periodStart) || !DATE.test(periodEnd) || !periodStart.endsWith("-01")) return false;
  const end = new Date(`${periodStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10) === periodEnd;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to confirm payout stations.", 401);
    const accessSurface = currentAdminAccessSurface();
    const pageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit")) {
      return errorResponse("Edit access to Workforce Payouts is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "").trim().toLowerCase();
    const audience = audienceValue(body.audience);
    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    const stationIds = [...new Set((Array.isArray(body.stationIds) ? body.stationIds : [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => UUID.test(value)))];
    if (!audience) return errorResponse("Choose Workforce or Helpers.", 400);
    if (!completeMonth(periodStart, periodEnd)) return errorResponse("Confirm stations for a complete calendar month only.", 400);
    if (!stationIds.length) return errorResponse("Select at least one station.", 400);
    if (action !== "confirm" && action !== "reopen") return errorResponse("Choose confirm or reopen.", 400);
    assertStationScope(authorization, stationIds);

    const results = [];
    for (const stationId of stationIds) {
      if (action === "confirm") {
        const confirmed = await supabaseAdmin.rpc("workforce_payout_station_release_confirm", {
          p_company: companyId,
          p_actor: authorization.userId,
          p_audience: audience,
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_station: stationId,
          p_expected_hash: typeof body.expectedHash === "string" ? body.expectedHash : null
        });
        if (confirmed.error) return errorResponse(confirmed.error.message, /changed|Publish|complete|access|authorised/i.test(confirmed.error.message) ? 409 : 400);
        results.push(confirmed.data);
      } else {
        const reopened = await supabaseAdmin.rpc("workforce_payout_station_release_reopen", {
          p_company: companyId,
          p_actor: authorization.userId,
          p_audience: audience,
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_station: stationId
        });
        if (reopened.error) return errorResponse(reopened.error.message, /enquiry|confirmed|access|authorised/i.test(reopened.error.message) ? 409 : 400);
        results.push({ stationId, reopened: true });
      }
    }

    revalidatePath("/payments/workforce-payouts");
    return Response.json({ ok: true, action, results }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update station confirmation.", 400);
  }
}
