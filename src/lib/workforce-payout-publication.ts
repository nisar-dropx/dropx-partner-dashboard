import { createHash } from "node:crypto";

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

export function workforcePayoutPublicationSnapshotHash(snapshot: ReturnType<typeof buildWorkforcePayoutPublicationSnapshot>) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function workforcePayoutCalculationHash(
  row: WorkforcePayoutRow,
  periodStart: string,
  periodEnd: string
) {
  return workforcePayoutPublicationSnapshotHash(
    buildWorkforcePayoutPublicationSnapshot(row, periodStart, periodEnd, "")
  );
}
