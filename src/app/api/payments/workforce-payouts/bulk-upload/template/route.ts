import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  buildWorkforcePayoutImportTemplate,
  isValidWorkforcePayoutDate,
  normalizeWorkforcePayoutCode,
  type WorkforcePayoutImportTemplateField
} from "@/lib/workforce-payout-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to download a payout upload template.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "edit")) {
      return errorResponse("Payout edit access is required to download this template.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const url = new URL(request.url);
    const requestedFrom = url.searchParams.get("effective_from") ?? "";
    const requestedTo = url.searchParams.get("effective_to") ?? "";
    const effectiveFrom = isValidWorkforcePayoutDate(requestedFrom) ? requestedFrom : undefined;
    const effectiveTo = isValidWorkforcePayoutDate(requestedTo) ? requestedTo : undefined;
    if ((requestedFrom && !effectiveFrom) || (requestedTo && !effectiveTo) || (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom)) {
      return errorResponse("Select a valid effective-from and effective-to date range.", 400);
    }

    const [paymentFieldsResult, additionalFieldsResult, deductionHeadsResult, stationsResult] = await Promise.all([
      supabaseAdmin
        .from("payment_fields")
        .select("code,label,field_type,calculation_type,pay_schedule,is_custom_production")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("code"),
      supabaseAdmin
        .from("workforce_additional_payment_fields")
        .select("code,name,calculation_type,default_rate_value")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("code"),
      supabaseAdmin
        .from("workforce_deduction_heads")
        .select("code,name,calculation_type,is_system")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("calculation_type", "manual")
        .eq("is_system", false)
        .neq("code", "ADVANCE")
        .order("code"),
      supabaseAdmin
        .from("stations")
        .select("id,station_code")
        .eq("company_id", companyId)
        .order("station_code")
    ]);
    const error = paymentFieldsResult.error?.message || additionalFieldsResult.error?.message
      || deductionHeadsResult.error?.message || stationsResult.error?.message;
    if (error) throw new Error(error);

    const fields: WorkforcePayoutImportTemplateField[] = [];
    for (const field of paymentFieldsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(field.code);
      fields.push({
        code,
        label: String(field.label ?? code),
        inputType: "PAYMENT_FIELD_VALUE",
        calculation: [field.calculation_type, field.pay_schedule].filter(Boolean).join(" / ") || "configured input",
        valueMeaning: "Configured rate/input override; the payment formula still calculates the payout."
      });
      if (field.field_type === "production") {
        fields.push({
          code,
          label: String(field.label ?? code),
          inputType: "PRODUCTION_UNITS",
          calculation: String(field.calculation_type ?? "count_x_rate"),
          valueMeaning: "Unit count for one work date. This replaces only this production field for that worker, location and date."
        });
      }
    }
    for (const field of additionalFieldsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(field.code);
      const calculation = String(field.calculation_type ?? "manual_amount");
      fields.push({
        code,
        label: String(field.name ?? code),
        inputType: "ADDITIONAL_PAYMENT",
        calculation,
        valueMeaning: calculation === "manual_amount"
          ? "Final additional amount for the exact payout period."
          : `Units multiplied by the configured rate${field.default_rate_value === null ? " (rate is not configured)" : ` ${field.default_rate_value}`}.`
      });
    }
    for (const head of deductionHeadsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(head.code);
      fields.push({
        code,
        label: String(head.name ?? code),
        inputType: "DEDUCTION",
        calculation: "manual deduction",
        valueMeaning: "Final deduction amount for the exact selected payout period."
      });
    }

    const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const allowedLocationIds = new Set(authorization.locationScopeIds);
    const locations = (stationsResult.data ?? [])
      .filter((station) => allLocations || allowedLocationIds.has(String(station.id)))
      .map((station) => ({ code: normalizeWorkforcePayoutCode(station.station_code) }))
      .filter((station) => station.code);
    const bytes = buildWorkforcePayoutImportTemplate(fields, { effectiveFrom, effectiveTo, locations });
    return new Response(Buffer.from(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="workforce-payout-inputs${effectiveFrom && effectiveTo ? `-${effectiveFrom}-to-${effectiveTo}` : ""}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to build the payout upload template.", 500);
  }
}
