import { revalidatePath } from "next/cache";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertStationScope,
  loadWorkforceStationFinanceRequests,
  loadWorkforceStationReleaseStates
} from "@/lib/workforce-payout-station-finance";

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

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to review Finance payout submissions.", 401);
    const accessSurface = currentAdminAccessSurface();
    const pageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "access") && !hasPermission(authorization, "payment_process", "view")) {
      return errorResponse("You do not have access to Workforce payout Finance status.", 403);
    }
    const url = new URL(request.url);
    const audience = audienceValue(url.searchParams.get("audience"));
    const periodStart = String(url.searchParams.get("periodStart") ?? "").trim();
    const periodEnd = String(url.searchParams.get("periodEnd") ?? "").trim();
    if (!audience || !completeMonth(periodStart, periodEnd)) {
      return errorResponse("Choose a Workforce/Helper complete month.", 400);
    }
    const companyId = requireCompanyId(authorization);
    const [releases, requests] = await Promise.all([
      loadWorkforceStationReleaseStates({ companyId, audience, periodStart, periodEnd }),
      loadWorkforceStationFinanceRequests({ companyId, audience, periodStart, periodEnd })
    ]);
    if (releases.error || requests.error) {
      return errorResponse(releases.error || requests.error || "Unable to load Finance status.", 503);
    }
    const releaseByStation = new Map(releases.releases.map((row) => [row.stationId.toLowerCase(), row]));
    return Response.json({
      releases: releases.releases,
      requests: requests.requests.map((requestRow) => ({
        ...requestRow,
        changed: releaseByStation.get(requestRow.stationId.toLowerCase())?.worksheetHash !== requestRow.worksheetHash
          || requestRow.changed
      }))
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load Finance status.", 400);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to update Finance payout submissions.", 401);
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const accessSurface = currentAdminAccessSurface();
    const pageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "").trim().toLowerCase();
    const companyId = requireCompanyId(authorization);

    if (action === "submit") {
      if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit")) {
        return errorResponse("Edit access to Workforce Payouts is required.", 403);
      }
      const audience = audienceValue(body.audience);
      const periodStart = String(body.periodStart ?? "").trim();
      const periodEnd = String(body.periodEnd ?? "").trim();
      const stationIds = [...new Set((Array.isArray(body.stationIds) ? body.stationIds : [])
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter((value) => UUID.test(value)))];
      if (!audience || !completeMonth(periodStart, periodEnd) || !stationIds.length) {
        return errorResponse("Select confirmed stations for a complete month.", 400);
      }
      assertStationScope(authorization, stationIds);
      const ids = [];
      for (const stationId of stationIds) {
        const release = await supabaseAdmin
          .from("workforce_payout_station_releases")
          .select("worksheet_hash")
          .eq("company_id", companyId)
          .eq("audience", audience)
          .eq("period_start", periodStart)
          .eq("period_end", periodEnd)
          .eq("station_id", stationId)
          .maybeSingle();
        if (release.error || !release.data) return errorResponse("Confirm each station before sending it to Finance.", 409);
        const submitted = await supabaseAdmin.rpc("workforce_payout_finance_submit", {
          p_company: companyId,
          p_actor: authorization.userId,
          p_audience: audience,
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_station: stationId,
          p_expected_hash: String(release.data.worksheet_hash)
        });
        if (submitted.error) return errorResponse(submitted.error.message, /Confirm|changed|access|authorised/i.test(submitted.error.message) ? 409 : 400);
        ids.push(submitted.data);
      }
      revalidatePath("/payments/workforce-payouts");
      return Response.json({ ok: true, requestIds: ids }, { headers: noStore });
    }

    if (action === "approve" || action === "return") {
      const canFinance = accessSurface === "finance"
        || hasPermission(authorization, "payment_process", "edit")
        || (accessSurface !== "ops" && hasPermission(authorization, "workforce_payouts", "edit"));
      if (authorization.readOnly || !canFinance) {
        return errorResponse("Finance payment permission is required to approve or return a station.", 403);
      }
      const requestId = String(body.requestId ?? "").trim().toLowerCase();
      const version = Number(body.version);
      const reason = String(body.reason ?? "").trim();
      if (!UUID.test(requestId) || !Number.isInteger(version) || version < 1) {
        return errorResponse("Choose a valid Finance submission to review.", 400);
      }
      if (reason.length < 10) return errorResponse("Record a Finance review reason (at least 10 characters).", 400);
      const decided = await supabaseAdmin.rpc("workforce_payout_finance_decide", {
        p_company: companyId,
        p_request: requestId,
        p_actor: authorization.userId,
        p_version: version,
        p_action: action,
        p_reason: reason
      });
      if (decided.error) return errorResponse(decided.error.message, /changed|approval|clearance|access|authorised/i.test(decided.error.message) ? 409 : 400);
      revalidatePath("/payments/workforce-payouts");
      return Response.json({ ok: true }, { headers: noStore });
    }

    return errorResponse("Choose submit, approve or return.", 400);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update Finance payout submissions.", 400);
  }
}
