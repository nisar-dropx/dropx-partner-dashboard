import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const noStore = { "Cache-Control": "private, no-store" };

type EligiblePayoutRpcRow = {
  dropx_id?: unknown;
  person_name?: unknown;
  target_type?: unknown;
  target_id?: unknown;
  workforce_id?: unknown;
  payout_engine?: unknown;
  payout_run_id?: unknown;
  payout_run_person_id?: unknown;
  station_id?: unknown;
  location_code?: unknown;
  payout_status?: unknown;
  is_editable?: unknown;
  lock_reason?: unknown;
  available_amount?: unknown;
};

type AvailableMonthRpcRow = {
  payout_month?: unknown;
  target_count?: unknown;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function periodEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function payoutIdentity(workforceId: unknown, locationId: unknown) {
  return `${String(workforceId ?? "").toLowerCase()}|${String(locationId ?? "").toLowerCase()}`;
}

function categoryLabel(targetType: string) {
  if (targetType === "employee") return "Employee";
  if (targetType === "contractor") return "Independent Contractor";
  return "Workforce";
}

function sourceLabel(payoutEngine: string) {
  return payoutEngine.startsWith("people") || payoutEngine === "hr"
    ? "People payroll"
    : "Workforce payout";
}

export async function GET(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to configure payment recoveries.", 401);
    if (!hasPermission(authorization, "payment_recoveries", "edit")) {
      return errorResponse("Edit access to Payment Recovery is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const requestedMonth = new URL(request.url).searchParams.get("month")?.trim() ?? "";
    const companyId = requireCompanyId(authorization);
    const companyWide = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    if (!requestedMonth) {
      const available = await supabaseAdmin.rpc("payment_recovery_available_payout_months", {
        p_company_id: companyId,
        p_allowed_location_ids: companyWide ? null : authorization.locationScopeIds
      });
      if (available.error) return errorResponse(available.error.message, 400);
      const months = ((available.data ?? []) as AvailableMonthRpcRow[])
        .map((row) => String(row.payout_month ?? "").slice(0, 7))
        .filter((month) => MONTH_PATTERN.test(month));
      return Response.json({ months }, { headers: noStore });
    }
    if (!MONTH_PATTERN.test(requestedMonth)) {
      return errorResponse("Select a valid payroll month.", 400);
    }

    const eligible = await readAllRows(
      supabaseAdmin.rpc("payment_recovery_eligible_payout_targets", {
        p_company_id: companyId,
        p_payout_month: `${requestedMonth}-01`,
        p_allowed_location_ids: companyWide ? null : authorization.locationScopeIds
      })
        .order("dropx_id")
        .order("target_type")
        .order("target_id")
    );
    if (eligible.error) return errorResponse(eligible.error.message, 400);

    const eligibleRows = (eligible.data ?? []) as EligiblePayoutRpcRow[];
    const workforceIds = [...new Set(eligibleRows.flatMap((row) =>
      String(row.payout_engine ?? "").toLowerCase() === "workforce" && row.workforce_id
        ? [String(row.workforce_id)]
        : []
    ))];
    const payoutAuthorization = companyWide && !authorization.hasAllLocationAccess
      ? { ...authorization, hasAllLocationAccess: true }
      : authorization;
    const workforcePayouts = workforceIds.length
      ? await loadWorkforcePayoutRows(
        companyId,
        payoutAuthorization,
        `${requestedMonth}-01`,
        periodEnd(requestedMonth),
        { workforceIds }
      )
      : { rows: [], error: null as string | null };
    if (workforcePayouts.error) return errorResponse(workforcePayouts.error, 400);
    const workforceByIdentity = new Map(workforcePayouts.rows.flatMap((row) =>
      row.reviewSubjectId && row.locationId
        ? [[payoutIdentity(row.reviewSubjectId, row.locationId), row] as const]
        : []
    ));

    const targets = eligibleRows.map((row) => {
      const targetType = String(row.target_type ?? "workforce").trim().toLowerCase();
      const payoutEngine = String(row.payout_engine ?? "workforce").trim().toLowerCase();
      const workforcePayout = payoutEngine === "workforce"
        ? workforceByIdentity.get(payoutIdentity(row.workforce_id, row.station_id))
        : null;
      const availableAmount = payoutEngine === "workforce"
        ? Math.max(0, Number(workforcePayout?.netAmount ?? 0) || 0)
        : Math.max(0, Number(row.available_amount ?? 0) || 0);
      const calculationReady = payoutEngine !== "workforce" || (
        Boolean(workforcePayout?.paymentDetailsAvailable)
        && workforcePayout?.status === "Ready for review"
        && availableAmount > 0
      );
      const calculationReason = payoutEngine === "workforce" && !calculationReady
        ? !workforcePayout
          ? "This exact-month Workforce payout calculation is unavailable."
          : workforcePayout.status === "Configuration incomplete"
            ? "This Workforce payout calculation is incomplete."
            : "This Workforce payout has no available amount for Recovery."
        : "";
      return {
        dropxId: String(row.dropx_id ?? ""),
        name: String(row.person_name ?? ""),
        category: categoryLabel(targetType),
        targetType,
        targetId: String(row.target_id ?? ""),
        workforceId: row.workforce_id ? String(row.workforce_id) : null,
        locationId: row.station_id ? String(row.station_id) : null,
        location: String(row.location_code ?? "—"),
        payoutSource: sourceLabel(payoutEngine),
        payoutEngine,
        payoutRunId: row.payout_run_id ? String(row.payout_run_id) : null,
        payoutRunPersonId: row.payout_run_person_id ? String(row.payout_run_person_id) : null,
        payoutStatus: String(row.payout_status ?? ""),
        isEditable: row.is_editable === true && calculationReady,
        lockReason: String(row.lock_reason ?? "") || calculationReason,
        availableAmount
      };
    });

    return Response.json({ month: requestedMonth, targets }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load eligible payout IDs.", 500);
  }
}
