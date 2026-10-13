import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  aggregateEffectivePaidHistory,
  aggregatePaymentCreditTransferMarkers,
  type EffectivePaidAllocationRow,
  type PaymentCreditTransferRow
} from "@/lib/workforce-payout-effective-payment-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type PayoutAudience = "workforce" | "helpers";

function payoutAudience(value: string | null): PayoutAudience | null {
  const normalized = String(value ?? "workforce").trim().toLowerCase();
  return normalized === "workforce" || normalized === "helpers" ? normalized : null;
}

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

function text(value: unknown) {
  return String(value ?? "").trim();
}

function paymentAmounts(instructionValue: unknown, settledValue: unknown, statusValue: unknown) {
  const instructionAmount = Number(instructionValue);
  const safeInstruction = Number.isFinite(instructionAmount) ? Math.max(0, instructionAmount) : 0;
  const settledAmount = Number(settledValue);
  const paid = text(statusValue).toLowerCase() === "paid";
  const amount = paid && Number.isFinite(settledAmount) && settledAmount > 0
    ? Math.min(safeInstruction, settledAmount)
    : safeInstruction;
  return {
    amount,
    instructionAmount: safeInstruction,
    status: paid && amount + 0.0001 < safeInstruction ? "partially_paid" : text(statusValue)
  };
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to view Workforce payment history.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "access")) return errorResponse("Access to Workforce Payouts is required.", 403);
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const params = new URL(request.url).searchParams;
    const audience = payoutAudience(params.get("audience"));
    if (!audience) return errorResponse("Choose a valid payout audience.", 400);
    const workforceId = String(params.get("workforceId") ?? "").trim().toLowerCase();
    const stationId = String(params.get("stationId") ?? "").trim().toLowerCase();
    const periodStart = String(params.get("periodStart") ?? "").trim();
    const periodEnd = String(params.get("periodEnd") ?? "").trim();
    if (!UUID.test(workforceId)) return errorResponse("A valid Workforce profile is required.", 400);
    if (!UUID.test(stationId)) return errorResponse("A valid payout location is required.", 400);
    if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Choose one complete payout month.", 400);
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.some((locationId) => String(locationId).toLowerCase() === stationId)) {
      return errorResponse("This payout location is outside your account access.", 403);
    }
    const companyId = requireCompanyId(authorization);
    const subjectColumn = audience === "helpers" ? "helper_id" : "workforce_id";
    const itemQuery = audience === "helpers"
      ? supabaseAdmin.from("helper_payout_payment_items")
      : supabaseAdmin.from("workforce_payout_payment_items");
    const holdQuery = audience === "helpers"
      ? supabaseAdmin.from("helper_payout_payment_hold_events")
      : supabaseAdmin.from("workforce_payout_payment_hold_events");

    const physicalItemsQuery = itemQuery
        .select("id,batch_id,reference_no,payment_version,instruction_amount,settled_amount,status,bank_response_status,bank_account_no_snapshot,ifsc_snapshot,response_debit_account_no,response_value_date,response_credit_account_no,response_ifsc,location_id_snapshot,location_code_snapshot,utr_cin,bank_processing_remarks,finalization_remarks,response_import_id,created_at,finalized_at")
        .eq("company_id", companyId)
        .eq(subjectColumn, workforceId)
        .eq("location_id_snapshot", stationId)
        .eq("period_start", periodStart)
        .eq("period_end", periodEnd)
        .order("payment_version", { ascending: false })
        .limit(100);
    const scopedPhysicalItemsQuery = audience === "workforce"
      ? physicalItemsQuery.neq("status", "paid")
      : physicalItemsQuery;

    const transferSelect = "id,decision_id,payment_item_id,payment_allocation_id,source_workforce_id,destination_workforce_id,station_id,period_start,period_end,amount,original_reference_snapshot,original_utr_cin_snapshot,created_at";
    const [itemsResult, holdEventsResult, sourceHoldResult, effectivePaidResult, transferOutResult, transferInResult] = await Promise.all([
      scopedPhysicalItemsQuery,
      // Profile hold events are intentionally profile-wide rather than tied to
      // one station. Do not disclose their remarks to a location-scoped viewer;
      // that viewer still receives the station-bound bank and source-hold data.
      authorization.hasAllLocationAccess
        ? holdQuery
          .select("id,action,remarks,created_at")
          .eq("company_id", companyId)
          .eq(subjectColumn, workforceId)
          .eq("period_start", periodStart)
          .eq("period_end", periodEnd)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(100)
        : Promise.resolve({ data: [], error: null }),
      audience === "workforce"
        ? supabaseAdmin.rpc("workforce_payout_source_payment_is_on_hold", {
          p_company_id: companyId,
          p_workforce_id: workforceId,
          p_station_id: stationId,
          p_period_start: periodStart,
          p_period_end: periodEnd
        })
        : Promise.resolve({ data: false, error: null }),
      audience === "workforce"
        ? supabaseAdmin
          .from("workforce_payout_effective_paid_allocations")
          .select("payment_allocation_id,payment_item_id,batch_id,original_workforce_id,credited_workforce_id,station_id,instruction_amount_snapshot,settled_amount_snapshot,status,reference_no,utr_cin,bank_account_no_snapshot,ifsc_snapshot,response_debit_account_no,response_value_date,response_credit_account_no,response_ifsc,location_code_snapshot,bank_processing_remarks,finalization_remarks,payment_version,created_at,finalized_at,was_transferred")
          .eq("company_id", companyId)
          .eq("credited_workforce_id", workforceId)
          .eq("station_id", stationId)
          .eq("period_start", periodStart)
          .eq("period_end", periodEnd)
          .order("payment_version", { ascending: false })
          .limit(500)
        : Promise.resolve({ data: [], error: null }),
      audience === "workforce"
        ? supabaseAdmin
          .from("workforce_payout_payment_credit_transfers")
          .select(transferSelect)
          .eq("company_id", companyId)
          .eq("source_workforce_id", workforceId)
          .eq("station_id", stationId)
          .eq("period_start", periodStart)
          .eq("period_end", periodEnd)
          .order("created_at", { ascending: false })
          .limit(500)
        : Promise.resolve({ data: [], error: null }),
      audience === "workforce"
        ? supabaseAdmin
          .from("workforce_payout_payment_credit_transfers")
          .select(transferSelect)
          .eq("company_id", companyId)
          .eq("destination_workforce_id", workforceId)
          .eq("station_id", stationId)
          .eq("period_start", periodStart)
          .eq("period_end", periodEnd)
          .order("created_at", { ascending: false })
          .limit(500)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (itemsResult.error) return errorResponse(itemsResult.error.message, 400);
    if (holdEventsResult.error) return errorResponse(holdEventsResult.error.message, 400);
    if (sourceHoldResult.error) return errorResponse(sourceHoldResult.error.message, 400);
    if (effectivePaidResult.error) return errorResponse(effectivePaidResult.error.message, 400);
    if (transferOutResult.error) return errorResponse(transferOutResult.error.message, 400);
    if (transferInResult.error) return errorResponse(transferInResult.error.message, 400);
    const physicalItems = itemsResult.data ?? [];
    const effectivePaidItems = aggregateEffectivePaidHistory((effectivePaidResult.data ?? []) as EffectivePaidAllocationRow[]);
    const transferOutMarkers = aggregatePaymentCreditTransferMarkers((transferOutResult.data ?? []) as PaymentCreditTransferRow[]);
    const transferInMarkers = aggregatePaymentCreditTransferMarkers((transferInResult.data ?? []) as PaymentCreditTransferRow[]);
    const incomingTransferByItem = new Map<string, (typeof transferInMarkers)[number]>();
    for (const marker of transferInMarkers) {
      if (!incomingTransferByItem.has(marker.paymentItemId)) incomingTransferByItem.set(marker.paymentItemId, marker);
    }
    const holdEvents = holdEventsResult.data ?? [];
    const profileOnHold = String(holdEvents[0]?.action ?? "") === "hold";
    const sourceOnHold = sourceHoldResult.data === true;
    const batchIds = [...new Set([
      ...physicalItems.map((item) => String(item.batch_id)),
      ...effectivePaidItems.map((item) => item.batchId)
    ].filter(Boolean))];
    const locationIds = [...new Set([
      ...physicalItems.map((item) => String(item.location_id_snapshot)),
      ...effectivePaidItems.map((item) => item.stationId),
      ...transferOutMarkers.map((marker) => marker.stationId)
    ].filter(Boolean))];
    const workforceIds = audience === "workforce" ? [...new Set([
      ...effectivePaidItems.flatMap((item) => [item.originalWorkforceId, item.creditedWorkforceId]),
      ...transferOutMarkers.flatMap((marker) => [marker.sourceWorkforceId, marker.destinationWorkforceId]),
      ...transferInMarkers.flatMap((marker) => [marker.sourceWorkforceId, marker.destinationWorkforceId])
    ].filter(Boolean))] : [];
    const locationsPromise = locationIds.length
      ? supabaseAdmin
        .from("stations")
        .select("id,station_code")
        .eq("company_id", companyId)
        .in("id", locationIds)
      : Promise.resolve({ data: [], error: null });
    const batchQuery = audience === "helpers"
      ? supabaseAdmin.from("helper_payout_payment_batches")
      : supabaseAdmin.from("workforce_payout_payment_batches");
    const batchesResult = batchIds.length
      ? await batchQuery
        .select("id,bank_id,status,debit_account_no_snapshot,value_date,generated_at")
        .eq("company_id", companyId)
        .in("id", batchIds)
      : { data: [], error: null };
    if (batchesResult.error) return errorResponse(batchesResult.error.message, 400);
    const batches = new Map((batchesResult.data ?? []).map((batch) => [String(batch.id), batch]));
    const bankIds = [...new Set((batchesResult.data ?? []).map((batch) => String(batch.bank_id)).filter(Boolean))];
    const banksPromise = bankIds.length
      ? supabaseAdmin
        .from("payment_banks")
        .select("id,display_name")
        .eq("company_id", companyId)
        .in("id", bankIds)
      : Promise.resolve({ data: [], error: null });
    const workforcePromise = workforceIds.length
      ? supabaseAdmin
        .from("workforce")
        .select("id,dropx_id,full_name")
        .eq("company_id", companyId)
        .in("id", workforceIds)
      : Promise.resolve({ data: [], error: null });
    const [banksResult, locationsResult, workforceResult] = await Promise.all([banksPromise, locationsPromise, workforcePromise]);
    if (banksResult.error) return errorResponse(banksResult.error.message, 400);
    const bankNames = new Map((banksResult.data ?? []).map((bank) => [String(bank.id), String(bank.display_name ?? "Bank")]));
    if (locationsResult.error) return errorResponse(locationsResult.error.message, 400);
    if (workforceResult.error) return errorResponse(workforceResult.error.message, 400);
    const locations = new Map((locationsResult.data ?? []).map((location) => [
      String(location.id),
      String(location.station_code ?? "").trim()
    ]));
    const workforceProfiles = new Map((workforceResult.data ?? []).map((profile) => [String(profile.id), {
      workforceId: String(profile.id),
      dropxId: String(profile.dropx_id ?? "").trim(),
      name: String(profile.full_name ?? "").trim()
    }]));
    const paymentItems = [
      ...physicalItems.map((item) => {
        const batch = batches.get(String(item.batch_id));
        const location = locations.get(String(item.location_id_snapshot ?? ""));
        const amounts = paymentAmounts(item.instruction_amount, item.settled_amount, item.status);
        const responseRemarks = item.response_import_id || String(item.bank_response_status ?? "").toUpperCase() === "MANUAL_PAID"
          ? text(item.bank_processing_remarks)
          : "";
        const finalizationRemarks = text(item.finalization_remarks)
          || (!item.response_import_id ? text(item.bank_processing_remarks) : "");
        const debitAccount = text(item.response_debit_account_no)
          || text(batch?.debit_account_no_snapshot);
        const creditAccount = text(item.response_credit_account_no)
          || text(item.bank_account_no_snapshot);
        const creditIfsc = text(item.response_ifsc) || text(item.ifsc_snapshot);
        return {
          id: String(item.id),
          batchId: String(item.batch_id),
          referenceNo: String(item.reference_no),
          version: Number(item.payment_version),
          instructionAmount: amounts.instructionAmount,
          amount: amounts.amount,
          status: amounts.status,
          bankName: bankNames.get(String(batch?.bank_id ?? "")) ?? "Bank",
          maskedDebitAccount: maskedAccount(debitAccount),
          creditAccount,
          creditIfsc,
          valueDate: text(item.response_value_date) || text(batch?.value_date),
          locationCode: text(item.location_code_snapshot) || location || "",
          utr: String(item.utr_cin ?? ""),
          responseRemarks,
          finalizationRemarks,
          remarks: responseRemarks || finalizationRemarks,
          generatedAt: String(batch?.generated_at ?? item.created_at ?? ""),
          finalizedAt: String(item.finalized_at ?? ""),
          redownloadable: String(batch?.status ?? "") === "processing" && String(item.status) === "processing",
          creditTransfer: null
        };
      }),
      ...effectivePaidItems.map((item) => {
        const batch = batches.get(item.batchId);
        const location = locations.get(item.stationId);
        const original = workforceProfiles.get(item.originalWorkforceId) ?? {
          workforceId: item.originalWorkforceId, dropxId: "", name: ""
        };
        const credited = workforceProfiles.get(item.creditedWorkforceId) ?? {
          workforceId: item.creditedWorkforceId, dropxId: "", name: ""
        };
        const incomingTransfer = incomingTransferByItem.get(item.id);
        return {
          id: item.id,
          batchId: item.batchId,
          referenceNo: item.referenceNo,
          version: item.version,
          instructionAmount: item.instructionAmount,
          amount: item.amount,
          status: item.status,
          bankName: bankNames.get(String(batch?.bank_id ?? "")) ?? "Bank",
          maskedDebitAccount: maskedAccount(item.responseDebitAccountNo || batch?.debit_account_no_snapshot),
          creditAccount: item.responseCreditAccountNo || item.bankAccountNoSnapshot,
          creditIfsc: item.responseIfsc || item.bankIfscSnapshot,
          valueDate: item.responseValueDate || text(batch?.value_date),
          locationCode: item.locationCodeSnapshot || location || "",
          utr: item.utr,
          responseRemarks: item.responseRemarks,
          finalizationRemarks: item.finalizationRemarks,
          remarks: item.responseRemarks || item.finalizationRemarks,
          generatedAt: String(batch?.generated_at ?? item.createdAt),
          finalizedAt: item.finalizedAt,
          redownloadable: false,
          creditTransfer: item.wasTransferred ? {
            wasTransferred: true,
            direction: item.originalWorkforceId === workforceId ? "returned" : "in",
            allocationCount: item.allocationCount,
            transferredAmount: incomingTransfer?.amount ?? item.amount,
            transferredAt: incomingTransfer?.createdAt ?? "",
            original,
            credited
          } : null
        };
      })
    ].sort((left, right) => right.version - left.version || right.generatedAt.localeCompare(left.generatedAt));

    return Response.json({
      hold: {
        onHold: profileOnHold || sourceOnHold,
        sourceOnHold,
        latestRemark: profileOnHold
          ? String(holdEvents[0]?.remarks ?? "")
          : sourceOnHold
            ? "A provider payout source at this location is On Hold."
            : String(holdEvents[0]?.remarks ?? ""),
        events: holdEvents.map((event) => ({
          id: String(event.id),
          action: String(event.action),
          remarks: String(event.remarks),
          createdAt: String(event.created_at)
        }))
      },
      items: paymentItems,
      creditTransfers: transferOutMarkers.map((marker) => ({
        ...marker,
        direction: "out",
        source: workforceProfiles.get(marker.sourceWorkforceId) ?? {
          workforceId: marker.sourceWorkforceId, dropxId: "", name: ""
        },
        destination: workforceProfiles.get(marker.destinationWorkforceId) ?? {
          workforceId: marker.destinationWorkforceId, dropxId: "", name: ""
        }
      }))
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load Workforce payment history.", 500);
  }
}
