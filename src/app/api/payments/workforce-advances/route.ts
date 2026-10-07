import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_MODES = new Set(["bank_transfer", "upi", "cash", "other"]);
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

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to add a Workforce advance.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_advances" : "workforce_advances";
    if (!hasPermission(authorization, pageCode, "add")) {
      return errorResponse("Add access to Workforce Advance Register is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const workforceId = String(body?.workforceId ?? "");
    const advanceDate = String(body?.advanceDate ?? "");
    const amount = Number(body?.amount);
    const paymentMode = String(body?.paymentMode ?? "other");
    const paymentReference = String(body?.paymentReference ?? "").trim();
    const externalReference = String(body?.externalReference ?? "").trim();
    const remark = String(body?.remark ?? "").trim();
    if (!UUID.test(workforceId)) return errorResponse("Select a valid Workforce member.", 400);
    if (!validDate(advanceDate)) return errorResponse("Enter a valid advance date.", 400);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      return errorResponse("Advance amount must be greater than zero and have at most two decimal places.", 400);
    }
    if (!PAYMENT_MODES.has(paymentMode)) return errorResponse("Select a valid payment mode.", 400);
    if (paymentReference.length > 160 || externalReference.length > 160 || remark.length > 500) {
      return errorResponse("One or more advance details exceed the allowed length.", 400);
    }

    const worker = await supabaseAdmin
      .from("workforce")
      .select("id,dropx_id,location_id")
      .eq("company_id", companyId)
      .eq("id", workforceId)
      .is("deleted_at", null)
      .or("migration_state.is.null,migration_state.neq.reclassified")
      .maybeSingle();
    if (worker.error) return errorResponse(worker.error.message, 400);
    const stationId = String(worker.data?.location_id ?? "");
    if (!worker.data || !UUID.test(stationId)) return errorResponse("This Workforce member does not have a valid location.", 400);
    const importedDropxId = String(worker.data.dropx_id ?? "").trim();
    if (!importedDropxId) return errorResponse("This Workforce member does not have a valid DropX ID.", 400);
    const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    if (!allLocations && !authorization.locationScopeIds.includes(stationId)) {
      return errorResponse("This Workforce member is outside your assigned locations.", 403);
    }

    const inserted = await supabaseAdmin.from("workforce_advances").insert({
      company_id: companyId,
      workforce_id: workforceId,
      station_id: stationId,
      imported_dropx_id: importedDropxId,
      link_status: "linked",
      advance_date: advanceDate,
      amount: Math.round(amount * 100) / 100,
      payment_mode: paymentMode,
      payment_reference: paymentReference || null,
      external_reference: externalReference || null,
      remark: remark || null,
      source_type: "manual",
      created_by: authorization.userId,
      updated_by: authorization.userId
    }).select("id,advance_number").single();
    if (inserted.error) {
      const conflict = inserted.error.code === "23505" || /duplicate|unique/i.test(inserted.error.message);
      return errorResponse(conflict ? "This advance reference is already registered." : inserted.error.message, conflict ? 409 : 400);
    }
    return Response.json({ id: inserted.data.id, advanceNumber: inserted.data.advance_number }, { status: 201, headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to add the Workforce advance.", 500);
  }
}
