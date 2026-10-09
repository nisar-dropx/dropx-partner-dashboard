import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const actions = new Set(["failed", "cancelled", "hold", "release_hold"]);

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

function completeCalendarMonth(periodStart: string, periodEnd: string) {
  if (!validDate(periodStart) || !validDate(periodEnd) || !periodStart.endsWith("-01")) return false;
  const expectedEnd = new Date(`${periodStart}T00:00:00Z`);
  expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
  expectedEnd.setUTCDate(0);
  return expectedEnd.toISOString().slice(0, 10) === periodEnd;
}

function databaseStatus(message: string) {
  return /processing|terminal|already|different request|not found|hold state/i.test(message) ? 409 : 400;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function jsonBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return JSON.parse(raw) as unknown;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);

    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to manage Workforce payment status.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit") || !hasPermission(authorization, "payment_process", "edit")) {
      return errorResponse("Edit access to Workforce Payouts and Payment Process is required.", 403);
    }
    if (!authorization.hasAllLocationAccess) {
      return errorResponse("Workforce payment status changes require all-location access.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    let body: Record<string, unknown>;
    try {
      const parsed = await jsonBody(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse("Submit a valid payment status request.", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        return errorResponse("The payment status request is too large.", 413);
      }
      return errorResponse("Submit a valid payment status request.", 400);
    }

    const action = String(body.action ?? "").trim().toLowerCase();
    const operationId = String(body.operationId ?? "").trim().toLowerCase();
    const remarks = String(body.remarks ?? "").trim();
    if (!actions.has(action)) return errorResponse("Choose a valid payment status action.", 400);
    if (!UUID.test(operationId)) return errorResponse("A valid operation ID is required.", 400);
    if (remarks.length < 3 || remarks.length > 1000) {
      return errorResponse("Enter a remark between 3 and 1000 characters.", 400);
    }

    const companyId = requireCompanyId(authorization);
    if (action === "failed" || action === "cancelled") {
      const paymentItemId = String(body.paymentItemId ?? "").trim().toLowerCase();
      if (!UUID.test(paymentItemId)) return errorResponse("A valid processing payment is required.", 400);
      const result = await supabaseAdmin.rpc("workforce_transition_payout_payment_item", {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_operation_id: operationId,
        p_payment_item_id: paymentItemId,
        p_outcome: action,
        p_remarks: remarks
      });
      if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
      return Response.json(resultRecord(result.data), { headers: noStore });
    }

    const workforceId = String(body.workforceId ?? "").trim().toLowerCase();
    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    if (!UUID.test(workforceId)) return errorResponse("A valid Workforce profile is required.", 400);
    if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Choose one complete payout month.", 400);
    const result = await supabaseAdmin.rpc("workforce_set_payout_payment_hold", {
      p_company_id: companyId,
      p_actor_user_id: authorization.userId,
      p_operation_id: operationId,
      p_workforce_id: workforceId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_hold: action === "hold",
      p_remarks: remarks
    });
    if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
    return Response.json(resultRecord(result.data), { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update Workforce payment status.", 500);
  }
}
