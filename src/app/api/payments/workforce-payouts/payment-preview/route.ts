import { loadPayoutProcessingInstructions } from "@/lib/payout-processing-instructions";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPayoutPaymentPreviews } from "@/lib/payout-payment-preview-batching";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Sign in to view payment status." }, { status: 401, headers });
  const accessSurface = currentAdminAccessSurface();
  const pageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
  if (!hasPermission(authorization, pageCode, "access")) return Response.json({ error: "Workforce Payouts access is required." }, { status: 403, headers });
  if (!supabaseAdmin) return Response.json({ error: "Payment status is temporarily unavailable." }, { status: 503, headers });
  try {
    const body = await request.json();
    const { periodStart, periodEnd } = body;
    const start = typeof periodStart === "string" && /^\d{4}-\d{2}-01$/.test(periodStart)
      ? new Date(`${periodStart}T00:00:00Z`) : null;
    if (!start || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== periodStart) {
      return Response.json({ error: "Choose a complete payout month." }, { status: 400, headers });
    }
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    if (periodEnd !== end.toISOString().slice(0, 10) || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 50) {
      return Response.json({ error: "Choose a complete payout month and up to 50 payout rows." }, { status: 400, headers });
    }
    const rows: { workforce_id: string; station_id: string }[] = [];
    const scope = new Set(authorization.locationScopeIds.map((id) => String(id).toLowerCase()));
    for (const row of body.rows) {
      if (!row || typeof row.workforceId !== "string" || typeof row.stationId !== "string"
        || !uuid.test(row.workforceId) || !uuid.test(row.stationId)) {
        return Response.json({ error: "Invalid payout identity." }, { status: 400, headers });
      }
      if (!authorization.hasAllLocationAccess && !scope.has(row.stationId.toLowerCase())) {
        return Response.json({ error: "This payout location is outside your access." }, { status: 403, headers });
      }
      // Only identities cross this boundary. Amounts, holds and dispute gates
      // are read from the existing authoritative bank-preview function.
      rows.push({ workforce_id: row.workforceId, station_id: row.stationId });
    }
    const admin = supabaseAdmin;
    const companyId = requireCompanyId(authorization);
    const canProcessPayments = !authorization.readOnly && hasPermission(authorization, pageCode, "edit")
      && (accessSurface === "ops" || hasPermission(authorization, "payment_process", "edit"));
    const result = await loadPayoutPaymentPreviews<{ workforce_id: string; station_id: string }, { workforce_id: string; station_id: string; payment_status?: string }, { message: string }>({
      rows,
      loadBatch: async (batch) => admin.rpc("workforce_preview_payout_payment_rows", {
        p_company_id: companyId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_rows: batch
      })
    });
    if (result.error) return Response.json({ error: "Payment status could not load. Please retry." }, { status: 503, headers });
    const processingRows = result.data.filter((row) => row.payment_status === "Payment Processing");
    if (!canProcessPayments || !processingRows.length) return Response.json({ rows: result.data }, { headers });

    const instructions = await loadPayoutProcessingInstructions(admin, companyId, "workforce", periodStart, periodEnd, processingRows);
    return Response.json({ rows: result.data.map((row) => {
      const instruction = instructions.get(`${row.workforce_id.toLowerCase()}|${row.station_id.toLowerCase()}`);
      return instruction ? { ...row, processingPaymentItemId: instruction.id, processingInstructionAmount: instruction.instructionAmount } : row;
    }) }, { headers });
  } catch {
    return Response.json({ error: "Payment status could not load. Please retry." }, { status: 400, headers });
  }
}
