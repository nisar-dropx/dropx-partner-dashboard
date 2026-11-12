import { chunkedValues, mapWithConcurrency } from "@/lib/bounded-concurrency";
import type { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

export async function loadPayoutProcessingInstructions(
  admin: NonNullable<typeof supabaseAdmin>,
  companyId: string,
  audience: "workforce" | "helpers",
  fromDate: string,
  toDate: string,
  payoutRows: readonly { workforce_id: string; station_id: string }[]
) {
  type ProcessingPaymentItem = {
    id: string;
    subject_id: string;
    location_id_snapshot: string;
    instruction_amount: number | string;
  };
  type ProcessingPaymentAllocation = {
    id: string;
    payment_item_id: string;
    station_id: string;
    instruction_amount_snapshot: number | string;
  };
  const visiblePayoutKeys = new Set(payoutRows.map((row) =>
    `${String(row.workforce_id).toLowerCase()}|${String(row.station_id).toLowerCase()}`
  ));
  const loadProcessingItems = async (subjectIds: string[]) => {
    const pageRows: ProcessingPaymentItem[] = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await admin
        .from(audience === "helpers" ? "helper_payout_payment_items" : "workforce_payout_payment_items")
        .select(audience === "helpers"
          ? "id,helper_id,location_id_snapshot,instruction_amount"
          : "id,workforce_id,location_id_snapshot,instruction_amount")
        .eq("company_id", companyId)
        .eq("period_start", fromDate)
        .eq("period_end", toDate)
        .eq("status", "processing")
        .in(audience === "helpers" ? "helper_id" : "workforce_id", subjectIds)
        .order("id")
        .range(offset, offset + 999);
      if (result.error) return { data: null, error: result.error };
      const currentPage = (result.data ?? []).map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          id: String(item.id),
          subject_id: String(audience === "helpers" ? item.helper_id : item.workforce_id),
          location_id_snapshot: String(item.location_id_snapshot),
          instruction_amount: Number(item.instruction_amount)
        } satisfies ProcessingPaymentItem;
      });
      pageRows.push(...currentPage.filter((item) => visiblePayoutKeys.has(
        `${item.subject_id.toLowerCase()}|${item.location_id_snapshot.toLowerCase()}`
      )));
      if (currentPage.length < 1000) break;
    }
    return { data: pageRows, error: null };
  };
  const subjectIds = [...new Set(payoutRows.map((row) => row.workforce_id.toLowerCase()))];
  const results = await mapWithConcurrency(chunkedValues(subjectIds, 100), 3, loadProcessingItems);
  const processingItems: ProcessingPaymentItem[] = [];
  for (const result of results) {
    if (result.error) throw result.error;
    processingItems.push(...result.data);
  }
  const allocationResults = audience === "workforce"
    ? await mapWithConcurrency(
      chunkedValues(processingItems.map((item) => item.id), 250),
      3,
      async (paymentItemIds) => readAllRows(admin
        .from("workforce_payout_payment_allocations")
        .select("id,payment_item_id,station_id,instruction_amount_snapshot")
        .eq("company_id", companyId)
        .in("payment_item_id", paymentItemIds)
        .order("payment_item_id")
        .order("id"))
    )
    : [];
  const processingAllocations: ProcessingPaymentAllocation[] = [];
  for (const result of allocationResults) {
    if (result.error) throw result.error;
    processingAllocations.push(...((result.data ?? []) as ProcessingPaymentAllocation[]));
  }
  const allocationsByPaymentItem = new Map<string, ProcessingPaymentAllocation[]>();
  for (const allocation of processingAllocations) {
    const itemId = String(allocation.payment_item_id).toLowerCase();
    const itemAllocations = allocationsByPaymentItem.get(itemId) ?? [];
    itemAllocations.push(allocation);
    allocationsByPaymentItem.set(itemId, itemAllocations);
  }
  const processingItemByPayoutRow = new Map<string, { id: string; instructionAmount: number }>();
  const ambiguousPayoutRows = new Set<string>();
  for (const item of processingItems) {
    const key = `${item.subject_id.toLowerCase()}|${item.location_id_snapshot.toLowerCase()}`;
    if (audience === "helpers") {
      if (processingItemByPayoutRow.has(key)) {
        processingItemByPayoutRow.delete(key);
        ambiguousPayoutRows.add(key);
      } else if (!ambiguousPayoutRows.has(key)) {
        processingItemByPayoutRow.set(key, {
          id: item.id,
          instructionAmount: Number(item.instruction_amount)
        });
      }
      continue;
    }
    const allocations = allocationsByPaymentItem.get(String(item.id).toLowerCase()) ?? [];
    const instructionAmount = Number(item.instruction_amount);
    const allocationAmount = Number(allocations[0]?.instruction_amount_snapshot);
    const isExactLocationInstruction = allocations.length === 1
      && String(allocations[0]?.station_id ?? "").toLowerCase() === String(item.location_id_snapshot).toLowerCase()
      && Number.isFinite(instructionAmount)
      && Number.isFinite(allocationAmount)
      && Math.round(allocationAmount * 100) === Math.round(instructionAmount * 100);
    if (!isExactLocationInstruction || processingItemByPayoutRow.has(key)) {
      processingItemByPayoutRow.delete(key);
      ambiguousPayoutRows.add(key);
      continue;
    }
    if (!ambiguousPayoutRows.has(key)) {
      processingItemByPayoutRow.set(key, { id: String(item.id), instructionAmount });
    }
  }
  return processingItemByPayoutRow;
}
