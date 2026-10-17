import {
  normalizeWorkforceBankReference,
  type WorkforceFedOneResponseRow
} from "./workforce-payout-bank-file.ts";

export type CentralBankLedger = "payment_requests" | "workforce" | "helpers" | "payroll";

export type CentralBankReferenceMatches = Partial<Record<CentralBankLedger, boolean>>;

/**
 * A reference must have exactly one company-owned ledger. The bank reference
 * namespaces pre-date the central importer and are not globally exclusive, so
 * an accidental collision is refused rather than guessed.
 */
export function resolveCentralBankRowOwner(input: {
  matches: CentralBankReferenceMatches;
  referenceNo: string;
  rowNumber: number;
}): CentralBankLedger | null {
  const owners = (Object.entries(input.matches) as Array<[CentralBankLedger, boolean | undefined]>)
    .filter(([, matched]) => matched)
    .map(([ledger]) => ledger);
  if (owners.length > 1) {
    throw new Error(
      `Row ${input.rowNumber}: reference “${normalizeWorkforceBankReference(input.referenceNo)}” matches multiple payment ledgers (${owners.join(", ")}). Nothing from this file was finalized.`
    );
  }
  return owners[0] ?? null;
}
export function centralBankRpcRow(row: WorkforceFedOneResponseRow) {
  return {
    row_number: row.rowNumber,
    reference_no: row.referenceNo,
    debit_account: row.debitAccount ?? "",
    credit_account: row.creditAccount,
    ifsc: row.ifsc,
    value_date: row.valueDate ?? "",
    debit_amount_paise: row.debitAmountPaise,
    status: row.status === "CANCELED" ? "CANCELLED" : row.status,
    utr_cin: row.utrCin,
    remarks: row.remarks
  };
}
