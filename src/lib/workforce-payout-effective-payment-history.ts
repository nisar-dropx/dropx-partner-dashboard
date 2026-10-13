export type EffectivePaidAllocationRow = {
  payment_allocation_id: string;
  payment_item_id: string;
  batch_id: string;
  original_workforce_id: string;
  credited_workforce_id: string;
  station_id: string;
  instruction_amount_snapshot: number | string;
  settled_amount_snapshot: number | string;
  status: string;
  reference_no: string;
  utr_cin: string | null;
  bank_account_no_snapshot: string | null;
  ifsc_snapshot: string | null;
  response_debit_account_no: string | null;
  response_value_date: string | null;
  response_credit_account_no: string | null;
  response_ifsc: string | null;
  location_code_snapshot: string | null;
  bank_processing_remarks: string | null;
  finalization_remarks: string | null;
  payment_version: number | string;
  created_at: string;
  finalized_at: string | null;
  was_transferred: boolean;
};

export type EffectivePaidHistoryItem = {
  id: string;
  batchId: string;
  originalWorkforceId: string;
  creditedWorkforceId: string;
  stationId: string;
  referenceNo: string;
  version: number;
  instructionAmount: number;
  amount: number;
  status: "paid" | "partially_paid";
  bankAccountNoSnapshot: string;
  bankIfscSnapshot: string;
  responseDebitAccountNo: string;
  responseValueDate: string;
  responseCreditAccountNo: string;
  responseIfsc: string;
  locationCodeSnapshot: string;
  utr: string;
  responseRemarks: string;
  finalizationRemarks: string;
  remarks: string;
  createdAt: string;
  finalizedAt: string;
  allocationCount: number;
  wasTransferred: boolean;
};

export type PaymentCreditTransferRow = {
  id: string;
  decision_id: string;
  payment_item_id: string;
  payment_allocation_id: string;
  source_workforce_id: string;
  destination_workforce_id: string;
  station_id: string;
  period_start: string;
  period_end: string;
  amount: number | string;
  original_reference_snapshot: string;
  original_utr_cin_snapshot: string;
  created_at: string;
};

export type PaymentCreditTransferMarker = {
  id: string;
  decisionId: string;
  paymentItemId: string;
  sourceWorkforceId: string;
  destinationWorkforceId: string;
  stationId: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  referenceNo: string;
  utr: string;
  createdAt: string;
  allocationCount: number;
};

function amount(value: number | string, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} contains an invalid amount.`);
  return parsed;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function allocationAmounts(row: EffectivePaidAllocationRow) {
  const instruction = roundMoney(amount(row.instruction_amount_snapshot, "Effective paid instruction allocation"));
  const settled = roundMoney(amount(row.settled_amount_snapshot, "Effective paid settlement allocation"));
  if (settled > instruction) {
    throw new Error("Effective paid settlement allocation exceeds its immutable payment instruction.");
  }
  return { instruction, settled };
}

export function aggregateEffectivePaidHistory(rows: EffectivePaidAllocationRow[]) {
  const grouped = new Map<string, EffectivePaidHistoryItem>();
  for (const row of rows) {
    const paymentItemId = String(row.payment_item_id ?? "").trim();
    if (!paymentItemId) continue;
    const allocation = allocationAmounts(row);
    const existing = grouped.get(paymentItemId);
    if (existing) {
      if (existing.batchId !== String(row.batch_id ?? "")
        || existing.originalWorkforceId !== String(row.original_workforce_id ?? "")
        || existing.creditedWorkforceId !== String(row.credited_workforce_id ?? "")
        || existing.stationId !== String(row.station_id ?? "")
        || existing.referenceNo !== String(row.reference_no ?? "")
        || existing.utr !== String(row.utr_cin ?? "")
        || existing.bankAccountNoSnapshot !== String(row.bank_account_no_snapshot ?? "")
        || existing.bankIfscSnapshot !== String(row.ifsc_snapshot ?? "")
        || existing.responseDebitAccountNo !== String(row.response_debit_account_no ?? "")
        || existing.responseValueDate !== String(row.response_value_date ?? "")
        || existing.responseCreditAccountNo !== String(row.response_credit_account_no ?? "")
        || existing.responseIfsc !== String(row.response_ifsc ?? "")
        || existing.locationCodeSnapshot !== String(row.location_code_snapshot ?? "")
        || existing.responseRemarks !== String(row.bank_processing_remarks ?? "")
        || existing.finalizationRemarks !== String(row.finalization_remarks ?? "")) {
        throw new Error("Effective paid allocations contain conflicting bank evidence for one payment item.");
      }
      existing.instructionAmount = roundMoney(existing.instructionAmount + allocation.instruction);
      existing.amount = roundMoney(existing.amount + allocation.settled);
      existing.status = existing.amount < existing.instructionAmount ? "partially_paid" : "paid";
      existing.allocationCount += 1;
      existing.wasTransferred = existing.wasTransferred || row.was_transferred === true;
      continue;
    }
    grouped.set(paymentItemId, {
      id: paymentItemId,
      batchId: String(row.batch_id ?? ""),
      originalWorkforceId: String(row.original_workforce_id ?? ""),
      creditedWorkforceId: String(row.credited_workforce_id ?? ""),
      stationId: String(row.station_id ?? ""),
      referenceNo: String(row.reference_no ?? ""),
      version: Number(row.payment_version) || 0,
      instructionAmount: allocation.instruction,
      amount: allocation.settled,
      status: allocation.settled < allocation.instruction
        ? "partially_paid"
        : "paid",
      bankAccountNoSnapshot: String(row.bank_account_no_snapshot ?? ""),
      bankIfscSnapshot: String(row.ifsc_snapshot ?? ""),
      responseDebitAccountNo: String(row.response_debit_account_no ?? ""),
      responseValueDate: String(row.response_value_date ?? ""),
      responseCreditAccountNo: String(row.response_credit_account_no ?? ""),
      responseIfsc: String(row.response_ifsc ?? ""),
      locationCodeSnapshot: String(row.location_code_snapshot ?? ""),
      utr: String(row.utr_cin ?? ""),
      responseRemarks: String(row.bank_processing_remarks ?? ""),
      finalizationRemarks: String(row.finalization_remarks ?? ""),
      remarks: String(row.bank_processing_remarks ?? ""),
      createdAt: String(row.created_at ?? ""),
      finalizedAt: String(row.finalized_at ?? ""),
      allocationCount: 1,
      wasTransferred: row.was_transferred === true
    });
  }
  return [...grouped.values()].sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
}

export function aggregatePaymentCreditTransferMarkers(rows: PaymentCreditTransferRow[]) {
  const grouped = new Map<string, PaymentCreditTransferMarker>();
  for (const row of rows) {
    const decisionId = String(row.decision_id ?? "").trim();
    const paymentItemId = String(row.payment_item_id ?? "").trim();
    if (!decisionId || !paymentItemId) continue;
    const key = `${decisionId}:${paymentItemId}`;
    const existing = grouped.get(key);
    if (existing) {
      if (existing.sourceWorkforceId !== String(row.source_workforce_id ?? "")
        || existing.destinationWorkforceId !== String(row.destination_workforce_id ?? "")
        || existing.stationId !== String(row.station_id ?? "")
        || existing.referenceNo !== String(row.original_reference_snapshot ?? "")
        || existing.utr !== String(row.original_utr_cin_snapshot ?? "")) {
        throw new Error("Paid-credit transfer audit contains conflicting evidence for one decision.");
      }
      existing.amount = roundMoney(existing.amount + amount(row.amount, "Paid-credit transfer"));
      existing.allocationCount += 1;
      if (String(row.created_at ?? "") > existing.createdAt) existing.createdAt = String(row.created_at ?? "");
      continue;
    }
    grouped.set(key, {
      id: `transfer-out:${decisionId}:${paymentItemId}`,
      decisionId,
      paymentItemId,
      sourceWorkforceId: String(row.source_workforce_id ?? ""),
      destinationWorkforceId: String(row.destination_workforce_id ?? ""),
      stationId: String(row.station_id ?? ""),
      periodStart: String(row.period_start ?? ""),
      periodEnd: String(row.period_end ?? ""),
      amount: roundMoney(amount(row.amount, "Paid-credit transfer")),
      referenceNo: String(row.original_reference_snapshot ?? ""),
      utr: String(row.original_utr_cin_snapshot ?? ""),
      createdAt: String(row.created_at ?? ""),
      allocationCount: 1
    });
  }
  return [...grouped.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
