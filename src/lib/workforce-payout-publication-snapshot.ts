import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";

function productionCounts(lines: WorkforcePayoutRow["productionBreakdown"]) {
  const count = (aliases: string[]) => lines
    .filter((line) => aliases.includes(String(line.code).trim().toUpperCase()))
    .reduce((sum, line) => sum + Number(line.count ?? 0), 0);
  return {
    totalDelivery: count(["DELIVERY", "TOTAL_DELIVERY", "AMAZON_DELIVERY", "SWA_DELIVERY"]),
    customerReturn: count(["CRETURN", "C_RETURN", "CUSTOMER_RETURN"]),
    mfn: count(["SELLER_PICKUP", "MFN"]),
    mfnReturn: count(["SLLLER_RETURN", "SELLER_RETURN", "MFN_RETURN"])
  };
}

export function buildWorkforcePayoutPublicationSnapshot(
  row: WorkforcePayoutRow,
  periodStart: string,
  periodEnd: string,
  dependencyHash: string
) {
  const dailyLines = row.dailyBreakdown.map((day, index) => {
    const counts = productionCounts(day.lines);
    return {
      id: `${row.id}:${day.date}:${index}`,
      source_id: `${row.id}:${day.date}:${index}`,
      work_date: day.date,
      source_type: "worksheet",
      provider_member_id: row.providerMemberId || null,
      base_amount: day.baseAmount,
      incentive_amount: 0,
      adjustment_amount: 0,
      net_amount: day.baseAmount,
      calculation_snapshot: {
        providerMemberName: row.providerMemberName,
        attendanceSource: day.attendanceSource,
        workDayUnits: day.workDayUnits,
        attendanceRange: day.attendanceRange ?? null,
        counts,
        paymentMethods: day.methodAmounts,
        paymentLines: day.lines
      }
    };
  });
  const additionLines = (row.additionalPaymentBreakdown ?? []).map((line, index) => ({
    id: `${row.id}:addition:${line.fieldId}:${index}`,
    source_id: `${row.id}:addition:${line.fieldId}:${index}`,
    work_date: periodEnd,
    source_type: "additional_payment",
    provider_member_id: row.providerMemberId || null,
    base_amount: 0,
    incentive_amount: 0,
    adjustment_amount: line.amount,
    net_amount: line.amount,
    calculation_snapshot: {
      category: line.code,
      reason: line.label,
      calculationType: line.calculationType,
      inputValue: line.inputValue,
      rateValue: line.rateValue
    }
  }));
  const deductionLines = row.deductionBreakdown.map((line, index) => ({
    id: `${row.id}:deduction:${line.code}:${index}`,
    source_id: `${row.id}:deduction:${line.code}:${index}`,
    work_date: periodEnd,
    source_type: "deduction",
    provider_member_id: row.providerMemberId || null,
    base_amount: 0,
    incentive_amount: 0,
    adjustment_amount: -Math.abs(line.amount),
    net_amount: -Math.abs(line.amount),
    calculation_snapshot: {
      category: line.code,
      reason: line.label
    }
  }));
  const lines = [...dailyLines, ...additionLines, ...deductionLines];
  return {
    schema_version: 2,
    source: "workforce_payout_worksheet",
    dependency_hash: dependencyHash,
    run: {
      period_start: periodStart,
      period_end: periodEnd
    },
    item: {
      workforce_id: String(row.reviewSubjectId),
      station_id: String(row.locationId),
      worker_name: row.name,
      dropx_id: row.dropxId,
      station_code: row.location,
      designation: row.designation,
      provider_member_ids: row.providerMemberId && row.providerMemberId !== "No provider ID"
        ? [row.providerMemberId]
        : [],
      work_days: row.workDays,
      base_amount: row.baseAmount,
      incentive_amount: 0,
      adjustment_amount: row.additions,
      deduction_amount: row.deductions,
      gross_amount: row.grossPayment,
      net_amount: row.netAmount
    },
    lines,
    worksheet: {
      row_id: row.id,
      dropx_status: row.dropxStatus,
      provider: row.provider,
      model: row.model,
      mapping_status: row.mappingStatus,
      payment_method: row.paymentMethod,
      work_days_source: row.workDaysSource,
      payment_method_breakdown: row.paymentMethodBreakdown,
      production_breakdown: row.productionBreakdown,
      additional_payment_breakdown: row.additionalPaymentBreakdown ?? [],
      deduction_breakdown: row.deductionBreakdown,
      daily_breakdown: row.dailyBreakdown,
      pan_aadhaar_status: row.panAadhaarStatus
    }
  };
}

export type WorkforcePayoutPublicationSnapshot = ReturnType<typeof buildWorkforcePayoutPublicationSnapshot>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Synthetic payout-input rows are the only worksheet rows allowed to disappear
 * after an input CLEAR. A mapped row disappearing signals an incomplete
 * recalculation and must be retried instead of silently publishing zero.
 */
export function isInputOnlyWorkforcePayoutPublicationSnapshot(
  value: unknown
): value is WorkforcePayoutPublicationSnapshot {
  const snapshot = record(value);
  const item = record(snapshot?.item);
  const worksheet = record(snapshot?.worksheet);
  const lines = list(snapshot?.lines);
  const paymentMethods = list(worksheet?.payment_method_breakdown);
  const production = list(worksheet?.production_breakdown);
  const daily = list(worksheet?.daily_breakdown);
  if (!snapshot || !item || !worksheet || !lines || !paymentMethods || !production || !daily) return false;
  if (snapshot.schema_version !== 2 || snapshot.source !== "workforce_payout_worksheet") return false;
  if (!String(worksheet.row_id ?? "").startsWith("payout-input-")) return false;
  if (worksheet.mapping_status !== "Not required") return false;
  if (paymentMethods.length || production.length || daily.length) return false;
  if (Number(item.base_amount) !== 0 || Number(item.work_days) !== 0) return false;
  return lines.every((line) => {
    const row = record(line);
    return row?.source_type === "additional_payment" || row?.source_type === "deduction";
  });
}

export function buildClearedInputOnlyWorkforcePayoutPublicationSnapshot(
  previous: unknown,
  dependencyHash: string
): WorkforcePayoutPublicationSnapshot | null {
  if (!isInputOnlyWorkforcePayoutPublicationSnapshot(previous)) return null;
  const snapshot = previous as unknown as Record<string, unknown>;
  const item = snapshot.item as Record<string, unknown>;
  const worksheet = snapshot.worksheet as Record<string, unknown>;
  return {
    ...snapshot,
    dependency_hash: dependencyHash,
    item: {
      ...item,
      work_days: 0,
      base_amount: 0,
      incentive_amount: 0,
      adjustment_amount: 0,
      deduction_amount: 0,
      gross_amount: 0,
      net_amount: 0
    },
    lines: [],
    worksheet: {
      ...worksheet,
      payment_method: "",
      work_days_source: "Not required",
      payment_method_breakdown: [],
      production_breakdown: [],
      additional_payment_breakdown: [],
      deduction_breakdown: [],
      daily_breakdown: [],
      tombstone_reason: "input_values_cleared"
    }
  } as unknown as WorkforcePayoutPublicationSnapshot;
}
