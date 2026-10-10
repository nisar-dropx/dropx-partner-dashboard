import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isValidWorkforcePayoutDate,
  normalizeWorkforcePayoutCode
} from "@/lib/workforce-payout-import";
import type {
  WorkforcePayoutManualCatalog,
  WorkforcePayoutManualCatalogField
} from "@/lib/workforce-payout-manual-entry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function payoutPageCode() {
  return currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to edit payout inputs.", 401);
    if (!hasPermission(authorization, payoutPageCode(), "edit")) {
      return errorResponse("Payout edit access is required to load manual input fields.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const url = new URL(request.url);
    const audience = (url.searchParams.get("audience") ?? "workforce").trim().toLowerCase();
    if (audience !== "workforce" && audience !== "helpers") {
      return errorResponse("Payout audience is not supported.", 400);
    }
    const effectiveFrom = url.searchParams.get("effective_from") ?? "";
    const effectiveTo = url.searchParams.get("effective_to") ?? "";
    if (!isValidWorkforcePayoutDate(effectiveFrom)
      || !isValidWorkforcePayoutDate(effectiveTo)
      || effectiveTo < effectiveFrom) {
      return errorResponse("Select a valid payout period before editing inputs.", 400);
    }

    const [paymentFieldsResult, additionalFieldsResult, deductionHeadsResult, stationsResult] = await Promise.all([
      audience === "helpers"
        ? Promise.resolve({ data: [], error: null })
        : supabaseAdmin
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
        .select("id,station_code,station_name")
        .eq("company_id", companyId)
        .order("station_code")
    ]);
    const databaseError = paymentFieldsResult.error?.message
      || additionalFieldsResult.error?.message
      || deductionHeadsResult.error?.message
      || stationsResult.error?.message;
    if (databaseError) throw new Error(databaseError);

    const fields: WorkforcePayoutManualCatalogField[] = [
      {
        code: "WORK_HOURS",
        label: "Work hours",
        inputType: "ATTENDANCE",
        calculation: "Range quantity",
        valueMeaning: "Total attendance hours for the selected date range."
      },
      {
        code: "WORK_DAYS",
        label: "Work days",
        inputType: "ATTENDANCE",
        calculation: "Range quantity",
        valueMeaning: "Total attendance days for the selected date range."
      }
    ];
    for (const field of paymentFieldsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(field.code);
      if (!code) continue;
      const label = String(field.label ?? code);
      fields.push({
        code,
        label,
        inputType: "PAYMENT_FIELD_VALUE",
        calculation: [field.calculation_type, field.pay_schedule].filter(Boolean).join(" / ") || "Configured input",
        valueMeaning: "Configured rate or input override; the payment formula still calculates the payout."
      });
      if (field.field_type === "production") {
        fields.push({
          code,
          label,
          inputType: "PRODUCTION_UNITS",
          calculation: String(field.calculation_type ?? "count_x_rate"),
          valueMeaning: "Unit count for one work date."
        });
      }
    }
    for (const field of additionalFieldsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(field.code);
      if (!code) continue;
      const calculation = String(field.calculation_type ?? "manual_amount");
      fields.push({
        code,
        label: String(field.name ?? code),
        inputType: "ADDITIONAL_PAYMENT",
        calculation,
        valueMeaning: calculation === "manual_amount"
          ? "Final additional amount for the complete payout period."
          : `Units multiplied by the configured rate${field.default_rate_value === null ? "" : ` ${field.default_rate_value}`}.`
      });
    }
    for (const head of deductionHeadsResult.data ?? []) {
      const code = normalizeWorkforcePayoutCode(head.code);
      if (!code) continue;
      fields.push({
        code,
        label: String(head.name ?? code),
        inputType: "DEDUCTION",
        calculation: "Manual deduction",
        valueMeaning: "Final deduction amount for the complete payout period."
      });
    }

    const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const allowedLocationIds = new Set(authorization.locationScopeIds);
    const locations = (stationsResult.data ?? [])
      .filter((station) => allLocations || allowedLocationIds.has(String(station.id)))
      .map((station) => {
        const code = normalizeWorkforcePayoutCode(station.station_code);
        return {
          id: String(station.id),
          code,
          label: String(station.station_name ?? code)
        };
      })
      .filter((station) => station.id && station.code);
    const response: WorkforcePayoutManualCatalog = { fields, locations };
    return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load manual payout input fields.", 500);
  }
}
