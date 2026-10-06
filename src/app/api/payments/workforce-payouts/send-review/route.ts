import { getAuthorization, hasPermission } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutReviewTokenStatus } from "@/lib/workforce-payout-review-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function responseError(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function validDate(value: unknown) {
  const text = String(value ?? "");
  return DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return responseError("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return responseError("Sign in to submit payouts for review.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "edit")) {
      return responseError("Edit access to Workforce Payouts is required.", 403);
    }
    if (!supabaseAdmin) return responseError("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const periodStart = String(body?.periodStart ?? "");
    const periodEnd = String(body?.periodEnd ?? "");
    const items: unknown[] = Array.isArray(body?.items) ? body.items : [];
    if (!validDate(periodStart) || !validDate(periodEnd) || periodEnd < periodStart) {
      return responseError("Select a valid payout period.", 400);
    }
    if (!items.length) return responseError("Select at least one payout.", 400);
    if (items.length > 1000) return responseError("Submit at most 1000 payouts at a time.", 400);
    if (JSON.stringify(items).length > 1_000_000) return responseError("The selected payout request is too large.", 413);

    const normalized = items.map((source) => {
      const item = source as any;
      return {
        subject_type: item?.subjectType === "helper" ? "helper" : item?.subjectType === "workforce" ? "workforce" : "",
        subject_id: String(item?.subjectId ?? ""),
        location_id: item?.locationId ? String(item.locationId) : null,
        review_token: String(item?.reviewToken ?? "")
      };
    });
    if (normalized.some((item) => !item.subject_type || !UUID.test(item.subject_id) || !item.location_id || !UUID.test(item.location_id))) {
      return responseError("One or more selected payouts cannot be submitted for review.", 400);
    }
    const uniqueSubjects = new Set(normalized.map((item) => `${item.subject_type}:${item.subject_id.toLowerCase()}:${item.location_id!.toLowerCase()}`));
    if (uniqueSubjects.size !== normalized.length) {
      return responseError("A payout subject was selected more than once.", 400);
    }
    const verified = normalized.map((item) => ({
      ...item,
      expected_status: workforcePayoutReviewTokenStatus(item.review_token, {
        companyId,
        subjectType: item.subject_type as "workforce" | "helper",
        subjectId: item.subject_id,
        locationId: item.location_id!,
        periodStart,
        periodEnd
      })
    }));
    if (verified.some((item) => !item.expected_status)) {
      return responseError("One or more payouts are no longer ready for review. Refresh the page and select them again.", 409);
    }

    const result = await supabaseAdmin.rpc("workforce_send_payouts_for_review", {
      p_company: companyId,
      p_actor: authorization.userId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_items: verified.map(({ review_token: _reviewToken, ...item }) => item),
      p_locations: authorization.hasAllLocationAccess ? null : authorization.locationScopeIds
    });
    if (result.error) return responseError(result.error.message, 400);
    return Response.json({ submitted: Number(result.data ?? verified.length), status: "Under Review" }, { headers: noStore });
  } catch (error) {
    return responseError(error instanceof Error ? error.message : "Unable to send payouts for review.", 500);
  }
}
