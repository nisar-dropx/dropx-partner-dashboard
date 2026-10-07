import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "private, no-store" };

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to reassign a Workforce advance.", 401);
    const pageCode = currentAdminAccessSurface() === "ops"
      ? "ops_workforce_advances"
      : "workforce_advances";
    if (!hasPermission(authorization, pageCode, "edit")) {
      return errorResponse("Edit access to Workforce Advance Register is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const companyId = requireCompanyId(authorization);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return errorResponse("Enter valid reassignment details.", 400);
    const advanceId = String(body.advanceId ?? "").trim();
    const targetWorkforceId = String(body.targetWorkforceId ?? "").trim();
    const expectedWorkforceValue = body.expectedWorkforceId;
    const expectedWorkforceId = expectedWorkforceValue == null || String(expectedWorkforceValue).trim() === ""
      ? null
      : String(expectedWorkforceValue).trim();
    const rawExpectedIdentityRevision = body.expectedIdentityRevision;
    const expectedIdentityRevision = rawExpectedIdentityRevision == null || String(rawExpectedIdentityRevision).trim() === ""
      ? Number.NaN
      : Number(rawExpectedIdentityRevision);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!UUID.test(advanceId) || !UUID.test(targetWorkforceId)) {
      return errorResponse("Select a valid advance and target Workforce member.", 400);
    }
    if (expectedWorkforceId !== null && !UUID.test(expectedWorkforceId)) {
      return errorResponse("The current Workforce assignment is invalid. Refresh and try again.", 400);
    }
    if (!Number.isInteger(expectedIdentityRevision) || expectedIdentityRevision < 0) {
      return errorResponse("The advance identity revision is invalid. Refresh and try again.", 400);
    }
    if (reason.length < 3 || reason.length > 500) {
      return errorResponse("Enter a reassignment reason between 3 and 500 characters.", 400);
    }

    const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const reassigned = await supabaseAdmin.rpc("workforce_reassign_advance", {
      p_company_id: companyId,
      p_advance_id: advanceId,
      p_target_workforce_id: targetWorkforceId,
      p_expected_workforce_id: expectedWorkforceId,
      p_expected_identity_revision: expectedIdentityRevision,
      p_reason: reason,
      p_actor_user_id: authorization.userId,
      p_allowed_location_ids: allLocations ? null : authorization.locationScopeIds
    });
    if (reassigned.error) {
      const message = reassigned.error.message;
      if (/outside your assigned locations/i.test(message)) return errorResponse(message, 403);
      if (/no longer exists|not a canonical Workforce member|does not have a valid current location/i.test(message)) {
        return errorResponse(message, 404);
      }
      if (/assignment changed|already assigned|already has a deducted amount|matches more than one/i.test(message)) {
        return errorResponse(message, 409);
      }
      return errorResponse(message, 400);
    }

    return Response.json({ reassignment: reassigned.data }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to reassign the Workforce advance.", 500);
  }
}
