export function bankResponseGuidance(message: string, outcome = "") {
  if (/already|replayed/i.test(outcome)) return { column: "", action: "No action needed. This bank result is already recorded." };
  if (/^(paid|cancelled|failed)$/i.test(outcome)) return { column: "", action: "Bank result recorded." };
  if (/paid ad hoc|finalized Workforce payout/i.test(message)) return { column: "", action: "Finance must review the existing payment or closed payroll. Confirm any intended extra payment before reconciliation." };
  if (/time.?out|time limit|canceling statement|connection|fetch failed|could not be confirmed|not reachable/i.test(message)) return { column: "", action: "Re-upload the same file to retry. Completed rows are protected against duplicate payment records." };
  if (/role|permission|access|scope|eligible instruction visible/i.test(message)) return { column: "", action: "Use an authorised Finance processor for this location. No bank-file edit is required." };
  if (/approval|not ready|payment state/i.test(message)) return { column: "", action: "Open the payment request and check its approval and processing stage before retrying." };
  if (/payment method|account.transfer/i.test(message)) return { column: "", action: "Check the payment method on the request; this importer handles bank transfers." };
  if (/utr|cin/i.test(message)) return { column: "UTR/CIN", action: "Verify the bank UTR against the payment. Do not replace it or reuse another payment's UTR." };
  if (/ifsc/i.test(message)) return { column: "IFSC Code", action: "Compare the bank IFSC with the beneficiary on the original payment instruction." };
  if (/credit.account|beneficiary.account|account.*mismatch/i.test(message)) return { column: "Credit Account", action: "Compare the beneficiary account with the original instruction. Keep account numbers as text." };
  if (/debit.account/i.test(message)) return { column: "Debit Account", action: "Check the debit-account cell in the original bank export; keep the number as text." };
  if (/amount/i.test(message)) return { column: "Debit Amount", action: "Compare the bank amount with the approved payment. Investigate a difference before retrying." };
  if (/value.date|date/i.test(message)) return { column: "Value Date", action: "Use the settlement date from the original bank export." };
  if (/status/i.test(message)) return { column: "Status", action: "Use the bank's final payment status. Paid rows also need a UTR/CIN." };
  if (/reference|customer ref|duplicate|multiple|ambiguous/i.test(message)) return { column: "Customer Ref. No.", action: "Check this reference against the exported payment instruction. Do not substitute a person ID or invent a reference." };
  return { column: "", action: "Review the payment request and the bank evidence before retrying this row." };
}

export function bankResponseFileError(message: string) {
  if (/time.?out|canceling statement/i.test(message)) return "The bank check timed out. Re-upload this file; already recorded payments will be checked safely. No spreadsheet correction is needed.";
  return message;
}

export function bankResponseCsv(rows: Array<{ file: string; rowNumber: number; referenceNo: string; outcome: string; message: string; column?: string; cell?: string; action?: string }>) {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [["File", "Row", "Reference", "Result", "Column", "Cell", "Issue", "Next action"], ...rows.map(r => [r.file,r.rowNumber,r.referenceNo,r.outcome,r.column,r.cell,r.message,r.action])].map(row => row.map(cell).join(",")).join("\r\n");
}
