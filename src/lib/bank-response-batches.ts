/** Each call is a committed, idempotent DB transaction; one slow batch cannot undo earlier batches. */
export async function finalizeBankResponseBatches<T extends { rowNumber: number; referenceNo: string }>(input: {
  rows: T[];
  finalize: (rows: T[]) => Promise<Record<string, unknown>>;
  deadlineAt: number;
  now?: () => number;
  batchSize?: number;
}) {
  const now = input.now ?? Date.now;
  const size = input.batchSize ?? 20;
  if (!Number.isInteger(size) || size < 1) throw new Error("Invalid bank batch size.");
  const result: Record<string, any> = { rows: [], row_errors: [], payment_request_events: [], replayed_row_numbers: [], paid: 0, cancelled: 0, failed: 0, rejected: 0, unknown: 0, replayed_items: 0, replayed: false };
  for (let offset = 0; offset < input.rows.length; offset += size) {
    const batch = input.rows.slice(offset, offset + size);
    try {
      if (now() >= input.deadlineAt) throw new Error("Upload time limit reached. Re-upload this file to finish the remaining rows; completed payments will not be repeated.");
      const part = await input.finalize(batch);
      for (const key of ["rows", "row_errors", "payment_request_events", "replayed_row_numbers"]) {
        if (Array.isArray(part[key])) result[key].push(...part[key]);
      }
      for (const key of ["paid", "cancelled", "failed", "rejected", "unknown", "replayed_items"]) {
        if (part.replayed !== true) result[key] += Number(part[key] ?? 0);
      }
      if (part.replayed === true) {
        result.replayed_row_numbers.push(...batch.map(row => row.rowNumber));
        result.replayed_items += batch.length;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bank reconciliation could not be confirmed.";
      for (const row of batch) {
        result.rows.push({ row_number: row.rowNumber, reference_no: row.referenceNo, outcome: "rejected", message });
        result.row_errors.push({ row_number: row.rowNumber, reference_no: row.referenceNo, message });
        result.rejected += 1;
      }
    }
  }
  return result;
}
