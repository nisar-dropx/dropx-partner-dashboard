import type { WorkforcePayoutRow } from "../../components/workforce-payout-table.tsx";

type Payout = Pick<WorkforcePayoutRow, "paymentDetailsAvailable" | "status" | "netAmount" | "grossPayment">;

/** Missing route allowance does not erase pay already calculated by the payout engine. */
export function lossWorkforcePayable(rows: Payout[], allowedStatuses: readonly string[]) {
  const unavailable = (source: string) => ({ payable: null, gross: null, source });
  if (!rows.length) return unavailable("No workforce payout found for the selected salary month. Review payment mapping.");
  if (rows.some(row => !row.paymentDetailsAvailable))
    return unavailable("Payout payment details are incomplete or conflicting. Review the payout setup.");
  const blocked = rows.find(row => !allowedStatuses.includes(row.status)
    && !(row.status === "Route distance pending" && allowedStatuses.includes("Ready for review")));
  if (blocked) return unavailable(`Payout not ready: ${blocked.status}. Review the payout details.`);
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
