import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actions = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
const inlineSave = actions.slice(
  actions.indexOf("export async function saveProviderFirstMappingsInline"),
  actions.indexOf("export async function saveProviderFirstMapping(")
);

test("owner remaps preflight paid history before the atomic replacement", () => {
  assert.match(actions, /rowValue\(formData, index, "payment_transfer_action"\)/);
  assert.match(actions, /submittedAction === "transfer" \|\| submittedAction === "keep"/);
  assert.match(actions, /rpc\("workforce_mapping_paid_history_preview", \{/);
  assert.match(actions, /p_expected_old_mapping: replacement\.mappingId/);
  assert.match(actions, /p_new_workforce: replacement\.newWorkforceId/);
  assert.match(actions, /p_effective_from: replacement\.effectiveFrom/);
  assert.match(actions, /replacement: replacementState\.ownerReplacement/);
});

test("paid history requires an explicit transfer or keep confirmation", () => {
  assert.match(actions, /hasPaidHistory = details\.has_paid_history === true/);
  assert.match(actions, /if \(!paymentTransferAction\) \{[\s\S]*?paidHistoryTransfer: paymentTransferState\.confirmation/);
  assert.match(actions, /existingWorkforceId: replacement\.existingWorkforceId/);
  assert.match(actions, /newWorkforceId: replacement\.newWorkforceId/);
  assert.match(actions, /paidAmount,[\s\S]*?paymentCount/);
  assert.match(actions, /ambiguous_allocation_count/);
  assert.match(actions, /partial_period_allocation_count/);
  assert.match(actions, /payment_transfer_fingerprint/);
  assert.match(actions, /payment_transfer_operation_id/);
  assert.match(actions, /transferAllowed: !transferBlockedReason/);
  assert.match(actions, /existingStationId !== replacement\.newStationId/);
  assert.match(actions, /processingCount > 0[\s\S]*?currently processing/);
});

test("the confirmed decision is applied in the same RPC as the mapping replacement", () => {
  assert.match(actions, /rpc\("workforce_replace_joining_mapping_with_payment_decision", \{/);
  assert.match(actions, /p_payment_transfer_action: options\.paymentTransferDecision\.action/);
  assert.match(actions, /p_expected_payment_fingerprint: options\.paymentTransferDecision\.paymentFingerprint/);
  assert.match(actions, /p_operation_id: options\.paymentTransferDecision\.operationId/);
  assert.match(actions, /paymentTransferDecision: paymentTransferState\.decision/);
  assert.match(actions, /operationId: submittedOperationId/);
  assert.match(actions, /submittedFingerprint !== paymentFingerprint/);
});

test("same-owner location move and Keep all cannot submit a paid-history decision", () => {
  assert.match(actions, /ownerReplacement: changeKind === "owner" && existingOwnerId/);
  assert.match(actions, /if \(!replacement\) \{[\s\S]*?Paid payment history action is not valid for this mapping change/);
});

test("inline mapping saves immediately invalidate the payout worksheet", () => {
  assert.match(
    inlineSave,
    /revalidateTag\("ops-cps"\);\s*revalidatePath\("\/provider-id-mapping"\);\s*revalidatePath\("\/payments\/workforce-payouts"\);\s*return \{ ok: true/
  );
  assert.match(
    inlineSave,
    /if \(savedRows\.length\) \{\s*revalidateTag\("ops-cps"\);\s*revalidatePath\("\/provider-id-mapping"\);\s*revalidatePath\("\/payments\/workforce-payouts"\);\s*\}/
  );
});
