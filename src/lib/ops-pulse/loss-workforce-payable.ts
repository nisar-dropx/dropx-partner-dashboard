import type { WorkforcePayoutRow } from "../../components/workforce-payout-table.tsx";

type Payout = Pick<WorkforcePayoutRow, "paymentDetailsAvailable" | "status" | "netAmount" | "grossPayment"> & Partial<Pick<WorkforcePayoutRow, "paymentMethod" | "mappingStatus" | "additions" | "deductions" | "baseAmount" | "location">>;

/** Missing route allowance does not erase pay already calculated by the payout engine. */
export function lossWorkforcePayable(rows: Payout[], allowedStatuses: readonly string[]) {
  const unavailable = (source: string) => ({ payable: null, gross: null, source });
  if (!rows.length) return unavailable("No workforce payout found for the selected salary month. Review payment mapping.");
  if (rows.some(row => !row.paymentDetailsAvailable))
    return unavailable("Payout payment details are incomplete or conflicting. Review the payout setup.");
  // A verified NIL mapping is deliberately unpaid, even when production exists.
  // It must not erase pay earned at another station. Never ignore setup errors or money.
  const unpaidNil = (row: Payout) => row.paymentMethod?.trim().toUpperCase() === "NIL"
    && row.mappingStatus?.toLowerCase() === "mapped"
    && ["Awaiting production", "No eligible attendance", "No eligible accrual"].includes(row.status)
    && [row.netAmount, row.grossPayment, row.baseAmount, row.additions, row.deductions].every(value => value === 0);
  const blocked = rows.find(row => !allowedStatuses.includes(row.status) && !unpaidNil(row)
    && !(row.status === "Route distance pending" && allowedStatuses.includes("Ready for review")));
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
