import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateEffectivePaidHistory,
  aggregatePaymentCreditTransferMarkers
} from "./workforce-payout-effective-payment-history.ts";

test("effective paid history aggregates location allocations into one immutable bank entry", () => {
  const base = {
    payment_item_id: "item-1",
    batch_id: "batch-1",
    original_workforce_id: "old-worker",
    credited_workforce_id: "new-worker",
    station_id: "station-1",
    status: "paid",
    reference_no: "WFDF1079092026V1",
    utr_cin: "UTR-1",
    bank_account_no_snapshot: "00001234",
    ifsc_snapshot: "BANK0001234",
    response_debit_account_no: "99998888",
    response_value_date: "2026-10-02",
    response_credit_account_no: "00001234",
    response_ifsc: "BANK0001234",
    location_code_snapshot: "KTUB",
    bank_processing_remarks: "Bank accepted",
    finalization_remarks: "Imported from bank response",
    payment_version: 1,
    created_at: "2026-10-01T01:00:00Z",
    finalized_at: "2026-10-02T01:00:00Z",
    was_transferred: true
  };
  const result = aggregateEffectivePaidHistory([
    { ...base, payment_allocation_id: "allocation-1", instruction_amount_snapshot: "600.10", settled_amount_snapshot: "600.10" },
    { ...base, payment_allocation_id: "allocation-2", instruction_amount_snapshot: 399.9, settled_amount_snapshot: 399.9 }
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: "item-1",
    batchId: "batch-1",
    originalWorkforceId: "old-worker",
    creditedWorkforceId: "new-worker",
    stationId: "station-1",
    referenceNo: "WFDF1079092026V1",
    version: 1,
    instructionAmount: 1000,
    amount: 1000,
    status: "paid",
    bankAccountNoSnapshot: "00001234",
    bankIfscSnapshot: "BANK0001234",
    responseDebitAccountNo: "99998888",
    responseValueDate: "2026-10-02",
    responseCreditAccountNo: "00001234",
    responseIfsc: "BANK0001234",
    locationCodeSnapshot: "KTUB",
    utr: "UTR-1",
    responseRemarks: "Bank accepted",
    finalizationRemarks: "Imported from bank response",
    remarks: "Bank accepted",
    createdAt: "2026-10-01T01:00:00Z",
    finalizedAt: "2026-10-02T01:00:00Z",
    allocationCount: 2,
    wasTransferred: true
  });
});

test("effective paid history exposes the actual settlement and marks a short payment as partial", () => {
  const base = {
    payment_item_id: "item-partial",
    batch_id: "batch-2",
    original_workforce_id: "worker-1",
    credited_workforce_id: "worker-1",
    station_id: "station-1",
    status: "paid",
    reference_no: "WFDF1088092026V1",
    utr_cin: "UTR-PARTIAL",
    bank_account_no_snapshot: "OLD-CREDIT",
    ifsc_snapshot: "OLD-IFSC",
    response_debit_account_no: "DEBIT-1234",
    response_value_date: "2026-10-03",
    response_credit_account_no: "ACTUAL-CREDIT",
    response_ifsc: "ACTUAL-IFSC",
    location_code_snapshot: "KGQA",
    bank_processing_remarks: "Short credit",
    finalization_remarks: "Confirmed manually",
    payment_version: 1,
    created_at: "2026-10-01T01:00:00Z",
    finalized_at: "2026-10-03T01:00:00Z",
    was_transferred: false
  };
  const result = aggregateEffectivePaidHistory([
    { ...base, payment_allocation_id: "allocation-1", instruction_amount_snapshot: 700, settled_amount_snapshot: 350 },
    { ...base, payment_allocation_id: "allocation-2", instruction_amount_snapshot: 300, settled_amount_snapshot: 150 }
  ]);
  assert.equal(result[0].instructionAmount, 1000);
  assert.equal(result[0].amount, 500);
  assert.equal(result[0].status, "partially_paid");
  assert.equal(result[0].responseCreditAccountNo, "ACTUAL-CREDIT");
  assert.equal(result[0].responseIfsc, "ACTUAL-IFSC");
});

test("transfer-out markers aggregate allocations without becoming payment entries", () => {
  const base = {
    id: "transfer-1",
    decision_id: "decision-1",
    payment_item_id: "item-1",
    source_workforce_id: "old-worker",
    destination_workforce_id: "new-worker",
    station_id: "station-1",
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    original_reference_snapshot: "WFDF1079092026V1",
    original_utr_cin_snapshot: "UTR-1",
    created_at: "2026-10-12T04:00:00Z"
  };
  const result = aggregatePaymentCreditTransferMarkers([
    { ...base, payment_allocation_id: "allocation-1", amount: 250 },
    { ...base, id: "transfer-2", payment_allocation_id: "allocation-2", amount: "750.00" }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, 1000);
  assert.equal(result[0].allocationCount, 2);
  assert.equal(result[0].destinationWorkforceId, "new-worker");
  assert.equal(result[0].referenceNo, "WFDF1079092026V1");
});

test("effective history refuses to merge conflicting immutable bank evidence", () => {
  const base = {
    payment_item_id: "item-1",
    batch_id: "batch-1",
    original_workforce_id: "old-worker",
    credited_workforce_id: "new-worker",
    station_id: "station-1",
    instruction_amount_snapshot: 500,
    settled_amount_snapshot: 500,
    status: "paid",
    reference_no: "WFDF1079092026V1",
    utr_cin: "UTR-1",
    bank_account_no_snapshot: "00001234",
    ifsc_snapshot: "BANK0001234",
    response_debit_account_no: "99998888",
    response_value_date: "2026-10-02",
    response_credit_account_no: "00001234",
    response_ifsc: "BANK0001234",
    location_code_snapshot: "KTUB",
    bank_processing_remarks: "Paid",
    finalization_remarks: "Imported",
    payment_version: 1,
    created_at: "2026-10-01T01:00:00Z",
    finalized_at: "2026-10-02T01:00:00Z",
    was_transferred: true
  };
  assert.throws(() => aggregateEffectivePaidHistory([
    { ...base, payment_allocation_id: "allocation-1" },
    { ...base, payment_allocation_id: "allocation-2", utr_cin: "DIFFERENT-UTR" }
  ]), /conflicting bank evidence/);
});

test("effective history rejects an excess settlement allocation", () => {
  assert.throws(() => aggregateEffectivePaidHistory([{
    payment_allocation_id: "allocation-excess",
    payment_item_id: "item-excess",
    batch_id: "batch-excess",
    original_workforce_id: "worker-1",
    credited_workforce_id: "worker-1",
    station_id: "station-1",
    instruction_amount_snapshot: 500,
    settled_amount_snapshot: 500.01,
    status: "paid",
    reference_no: "WFDF1088092026V2",
    utr_cin: "UTR-EXCESS",
    bank_account_no_snapshot: "1234",
    ifsc_snapshot: "IFSC",
    response_debit_account_no: "9876",
    response_value_date: "2026-10-03",
    response_credit_account_no: "1234",
    response_ifsc: "IFSC",
    location_code_snapshot: "KTUB",
    bank_processing_remarks: "Paid",
    finalization_remarks: "Manual",
    payment_version: 2,
    created_at: "2026-10-03T01:00:00Z",
    finalized_at: "2026-10-03T02:00:00Z",
    was_transferred: false
  }]), /exceeds its immutable payment instruction/);
});
