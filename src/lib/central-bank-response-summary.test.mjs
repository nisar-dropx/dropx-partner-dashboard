import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCentralBankResponseRows } from "./central-bank-response-summary.ts";

test("central bank response rows are grouped once into reconciled, exceptions and skipped", () => {
  const groups = summarizeCentralBankResponseRows({
    databaseRows: [
      { ledger: "workforce", message: "Payment finalized.", outcome: "paid", reference_no: "WF1", row_number: 2 },
      { ledger: "helpers", message: "Return finalized.", outcome: "cancelled", reference_no: "HP1", row_number: 3 },
      { ledger: "people_payroll", message: "Failure recorded.", outcome: "failed", reference_no: "E1", row_number: 4 },
      { ledger: "payment_requests", message: "Already recorded.", outcome: "replayed", reference_no: "PR1", row_number: 5 },
      { ledger: "workforce", message: "Amount mismatch.", outcome: "rejected", reference_no: "WF2", row_number: 6 },
      { ledger: "helpers", message: "Instruction unavailable.", outcome: "unknown", reference_no: "HP2", row_number: 7 }
    ],
    issues: [
      { category: "exceptions", message: "Duplicate error detail.", referenceNo: "WF2", rowNumber: 6 },
      { category: "skipped", message: "No eligible instruction.", referenceNo: "OTHER", rowNumber: 8 },
      { category: "exceptions", message: "IFSC is invalid.", referenceNo: "WF3", rowNumber: 9 }
    ],
    replayedFile: false
  });

  assert.deepEqual(groups.reconciled.map((row) => [row.rowNumber, row.outcome]), [
    [2, "Paid"], [3, "Cancelled"], [4, "Failed"]
  ]);
  assert.deepEqual(groups.exceptions.map((row) => [row.rowNumber, row.outcome]), [
    [6, "Exception"], [9, "Exception"]
  ]);
  assert.deepEqual(groups.skipped.map((row) => [row.rowNumber, row.outcome]), [
    [7, "Skipped"], [8, "Skipped"]
  ]);
  assert.equal(
    groups.reconciled.length + groups.alreadyRecorded.length + groups.exceptions.length + groups.skipped.length,
    8,
    "every physical row is summarized exactly once"
  );
});

test("a replayed file reports its stored successful rows as already recorded instead of newly reconciled", () => {
  const groups = summarizeCentralBankResponseRows({
    databaseRows: [
      { ledger: "workforce", message: "Payment finalized.", outcome: "paid", reference_no: "WF1", row_number: 2 },
      { ledger: "helpers", message: "Return finalized.", outcome: "cancelled", reference_no: "HP1", row_number: 3 }
    ],
    issues: [],
    replayedFile: true
  });

  assert.equal(groups.reconciled.length, 0);
  assert.equal(groups.exceptions.length, 0);
  assert.deepEqual(groups.alreadyRecorded.map((row) => row.outcome), ["Already finalized", "Already finalized"]);
});

test("a successful row from a replayed chunk is already recorded even when another row makes the file a partial replay", () => {
  const groups = summarizeCentralBankResponseRows({
    databaseRows: [
      { ledger: "workforce", message: "Payment finalized.", outcome: "paid", reference_no: "WF1", row_number: 2 },
      { ledger: "helpers", message: "Amount does not match.", outcome: "rejected", reference_no: "HP1", row_number: 3 }
    ],
    issues: [],
    replayedFile: false,
    replayedRowNumbers: [2, "not-a-row", 0]
  });

  assert.equal(groups.reconciled.length, 0);
  assert.deepEqual(groups.exceptions.map((row) => [row.rowNumber, row.outcome]), [[3, "Exception"]]);
  assert.deepEqual(groups.alreadyRecorded.map((row) => [row.rowNumber, row.outcome]), [[2, "Already finalized"]]);
});

test("unsupported or missing database outcomes are exceptions, not harmless skips", () => {
  const groups = summarizeCentralBankResponseRows({
    databaseRows: [
      { ledger: "workforce", outcome: "deferred", reference_no: "WF1", row_number: 2 },
      { ledger: "helpers", outcome: "", reference_no: "HP1", row_number: 3 }
    ],
    issues: [],
    replayedFile: false
  });

  assert.deepEqual(groups.exceptions.map((row) => [row.rowNumber, row.outcome]), [
    [2, "Exception"], [3, "Exception"]
  ]);
  assert.equal(groups.reconciled.length, 0);
  assert.equal(groups.skipped.length, 0);
  assert.match(groups.exceptions[0].message, /unsupported or invalid/i);
});

test("malformed database details are ignored and source issues stay safely bounded", () => {
  const groups = summarizeCentralBankResponseRows({
    databaseRows: [{ outcome: "paid", row_number: 0 }, null, "invalid"],
    issues: [{
      category: "exceptions",
      message: "x".repeat(700),
      referenceNo: "R".repeat(200),
      rowNumber: 12
    }],
    replayedFile: false
  });

  assert.equal(groups.exceptions.length, 1);
  assert.equal(groups.exceptions[0].message.length, 500);
  assert.equal(groups.exceptions[0].referenceNo.length, 120);
  assert.equal(groups.reconciled.length, 0);
  assert.equal(groups.skipped.length, 0);
});
