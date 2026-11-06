import type { WorkforcePayoutRow } from "../../components/workforce-payout-table.tsx";

type Payout = Pick<WorkforcePayoutRow, "paymentDetailsAvailable" | "status" | "netAmount" | "grossPayment"> & Partial<Pick<WorkforcePayoutRow, "paymentMethod" | "mappingStatus" | "additions" | "deductions" | "baseAmount" | "location" | "production">>;

/** Missing route allowance does not erase pay already calculated by the payout engine. */
export function lossWorkforcePayable(rows: Payout[], allowedStatuses: readonly string[]) {
  const unavailable = (source: string) => ({ payable: null, gross: null, source });
  if (!rows.length) return unavailable("No workforce payout row for this DropX ID in the selected month. Check its provider ID mapping or direct pay allocation.");
  if (rows.some(row => !row.paymentDetailsAvailable))
    return unavailable("Payout payment details are incomplete or conflicting. Review the payout setup.");
  // An idle per-packet mapping earns zero at that station. Other stations can
  // still fund recovery. Positive production without calculated pay needs review.
  const readyForRecovery = (row: Payout) => allowedStatuses.includes(row.status)
    || (row.status === "Route distance pending" && allowedStatuses.includes("Ready for review"));
  const hasEarnedPay = rows.some(row => readyForRecovery(row) && row.netAmount > 0);
  const verifiedZeroRow = (row: Payout) => {
    if (row.mappingStatus?.toLowerCase() !== "mapped") return false;
    if (![row.netAmount, row.grossPayment, row.baseAmount, row.additions, row.deductions].every(value => value === 0)) return false;
    const method = row.paymentMethod?.trim().toUpperCase();
    if (method === "PER PACKET") return hasEarnedPay && row.status === "Awaiting production" && row.production === 0;
    return method === "NIL" && ["Awaiting production", "No eligible attendance", "No eligible accrual"].includes(row.status);
  };
  const blocked = rows.find(row => !readyForRecovery(row) && !verifiedZeroRow(row));
  if (blocked) {
    const next = blocked.status === "Awaiting production"
      ? "No payable earnings calculated; check production and the mapped payment rate."
      : blocked.status === "No eligible attendance" ? "Check attendance and payment eligibility."
      : "Correct the payout setup before allocating recovery.";
    return unavailable(`${blocked.location ? blocked.location + ": " : ""}${blocked.status}. ${next}`);
  }
  if (rows.some(row => !Number.isFinite(row.netAmount) || !Number.isFinite(row.grossPayment)))
    return unavailable("Payout amount could not be verified. Refresh the payout and retry.");
  return {
    payable: Math.max(0, Math.round(rows.reduce((sum, row) => sum + row.netAmount, 0) * 100) / 100),
    gross: Math.round(rows.reduce((sum, row) => sum + row.grossPayment, 0) * 100) / 100,
    source: rows.some(row => row.status === "Route distance pending")
      ? "Calculated payout · pending route allowance excluded"
      : "Calculated workforce payout",
  };
}
