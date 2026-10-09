import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
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

function maskedAccount(value: unknown) {
  const account = String(value ?? "").replace(/\s+/g, "");
  if (!account) return "";
  return `••••${account.slice(-4)}`;
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to view Workforce payment history.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit") || !hasPermission(authorization, "payment_process", "edit")) {
      return errorResponse("Edit access to Workforce Payouts and Payment Process is required.", 403);
    }
    if (!authorization.hasAllLocationAccess) return errorResponse("Bank payment history requires all-location access.", 403);
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const params = new URL(request.url).searchParams;
    const workforceId = String(params.get("workforceId") ?? "").trim().toLowerCase();
    const periodStart = String(params.get("periodStart") ?? "").trim();
    const periodEnd = String(params.get("periodEnd") ?? "").trim();
    if (!UUID.test(workforceId)) return errorResponse("A valid Workforce profile is required.", 400);
    if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Choose one complete payout month.", 400);
    const companyId = requireCompanyId(authorization);

    const itemsResult = await supabaseAdmin
      .from("workforce_payout_payment_items")
      .select("id,batch_id,reference_no,payment_version,instruction_amount,status,bank_account_no_snapshot,utr_cin,bank_processing_remarks,created_at,finalized_at")
      .eq("company_id", companyId)
      .eq("workforce_id", workforceId)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .order("payment_version", { ascending: false })
      .limit(100);
    if (itemsResult.error) return errorResponse(itemsResult.error.message, 400);
    const items = itemsResult.data ?? [];
    const batchIds = [...new Set(items.map((item) => String(item.batch_id)).filter(Boolean))];
    const batchesResult = batchIds.length
      ? await supabaseAdmin
        .from("workforce_payout_payment_batches")
        .select("id,bank_id,status,generated_at")
        .eq("company_id", companyId)
        .in("id", batchIds)
      : { data: [], error: null };
    if (batchesResult.error) return errorResponse(batchesResult.error.message, 400);
    const batches = new Map((batchesResult.data ?? []).map((batch) => [String(batch.id), batch]));
    const bankIds = [...new Set((batchesResult.data ?? []).map((batch) => String(batch.bank_id)).filter(Boolean))];
    const banksResult = bankIds.length
      ? await supabaseAdmin
        .from("payment_banks")
        .select("id,display_name")
        .eq("company_id", companyId)
        .in("id", bankIds)
      : { data: [], error: null };
    if (banksResult.error) return errorResponse(banksResult.error.message, 400);
    const bankNames = new Map((banksResult.data ?? []).map((bank) => [String(bank.id), String(bank.display_name ?? "Bank")]));

    return Response.json({
      items: items.map((item) => {
        const batch = batches.get(String(item.batch_id));
        return {
          id: String(item.id),
          batchId: String(item.batch_id),
          referenceNo: String(item.reference_no),
          version: Number(item.payment_version),
          amount: Number(item.instruction_amount),
          status: String(item.status),
          bankName: bankNames.get(String(batch?.bank_id ?? "")) ?? "Bank",
          maskedAccount: maskedAccount(item.bank_account_no_snapshot),
          utr: String(item.utr_cin ?? ""),
          remarks: String(item.bank_processing_remarks ?? ""),
          generatedAt: String(batch?.generated_at ?? item.created_at ?? ""),
          finalizedAt: String(item.finalized_at ?? ""),
          redownloadable: String(batch?.status ?? "") === "processing" && String(item.status) === "processing"
        };
      })
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load Workforce payment history.", 500);
  }
}
