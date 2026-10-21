import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actions = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
const inlineSave = actions.slice(
  actions.indexOf("export async function saveProviderFirstMappingsInline"),
  actions.indexOf("export async function saveProviderFirstMapping(")
);
const saveRow = actions.slice(
  actions.indexOf("async function saveExecutiveMappingRow"),
  actions.indexOf("export async function saveProviderMappingWorksheet")
);
const replacementState = actions.slice(
  actions.indexOf("async function providerFirstReplacementState"),
  actions.indexOf("async function providerFirstPaymentTransferState")
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

test("clearing a historical row never retargets a later active mapping", () => {
  const clearFlow = inlineSave.slice(
    inlineSave.indexOf('const clearRequested = rowValue(formData, index, "clear_mapping")'),
    inlineSave.indexOf('const workforceId = rowRequired(formData, index, "id"')
  );

  assert.match(clearFlow, /select\("id, workforce_id, station_id, provider_member_id, effective_from, effective_to, status"\)/);
  assert.match(clearFlow, /\.eq\("id", mappingId\)/);
  assert.match(clearFlow, /currentMapping\.status !== "active" \|\| currentMapping\.effective_to/);
  assert.match(clearFlow, /This mapping \$\{lifecycle\}/);
  assert.match(clearFlow, /Its history is preserved; choose an active, ongoing row to clear/);
  assert.match(clearFlow, /p_mapping: mappingId/);
  assert.doesNotMatch(clearFlow, /order\("effective_from"/);
});

test("bounded historical actions ignore only current mappings that start later", () => {
  assert.match(actions, /function currentProviderMappingOverlapsRequestedPeriod\(/);
  assert.match(actions, /!validProviderMappingDate\(requestedEffectiveFrom\)/);
  assert.match(actions, /!validProviderMappingDate\(requestedEffectiveTo\)/);
  assert.match(actions, /requestedEffectiveFrom > requestedEffectiveTo/);
  assert.match(actions, /return currentEffectiveFrom <= requestedEffectiveTo/);

  assert.match(replacementState, /select\("id, effective_from, effective_to, status"\)/);
  assert.match(replacementState, /providerPeriodById/);
  assert.match(replacementState, /period\.status !== "active" \|\| period\.effective_to !== null/);
  assert.match(replacementState, /const relevantTargetMappings = targetMappings\.filter\(activeMappingOverlapsRequestedPeriod\)/);
  assert.match(replacementState, /const relevantProviderMappings = providerMappings\.filter\(activeMappingOverlapsRequestedPeriod\)/);
  assert.match(replacementState, /new Set\(relevantProviderMappings\.map\(canonicalOwner\)\)/);
  assert.match(replacementState, /relevantProviderMappings\.find\(\(mapping\) => mapping\.station_id === stationId\)/);
  assert.match(replacementState, /const submittedMappingAtRequestedStart = submittedMapping/);
  assert.match(replacementState, /submittedMappingAtRequestedStart\s*\?\? targetMappingsAtRequestedStart\[0\]\s*\?\? providerMappingsAtRequestedStart\[0\]/);
  assert.doesNotMatch(replacementState, /\?\? relevantTargetMappings\[0\]/);
});

test("a submitted closed mapping is reused only for an exact same-owner identity and location edit", () => {
  const submittedQuery = replacementState.slice(
    replacementState.indexOf("const submittedMappingQuery"),
    replacementState.indexOf("const [targetResult", replacementState.indexOf("const submittedMappingQuery"))
  );
  const closedMappingCheck = replacementState.slice(
    replacementState.indexOf("const submittedClosedMapping"),
    replacementState.indexOf("const targetMappings", replacementState.indexOf("const submittedClosedMapping"))
  );
  const closedMappingResult = replacementState.slice(
    replacementState.indexOf("if (submittedClosedMapping)"),
    replacementState.indexOf("if (destinationMapping", replacementState.indexOf("if (submittedClosedMapping)"))
  );

  assert.match(submittedQuery, /\.eq\("company_id", companyId\)/);
  assert.match(submittedQuery, /\.eq\("id", submittedMappingId\)/);
  assert.match(submittedQuery, /\.neq\("status", "cancelled"\)/);
  assert.match(submittedQuery, /\.maybeSingle\(\)/);
  assert.match(closedMappingCheck, /submittedStoredMapping\.status === "closed"/);
  assert.match(closedMappingCheck, /Boolean\(submittedStoredMapping\.effective_to\)/);
  assert.match(closedMappingCheck, /String\(submittedStoredMapping\.effective_from \?\? ""\) === requestedEffectiveFrom/);
  assert.match(closedMappingCheck, /submittedStoredMapping\.station_id === stationId/);
  assert.match(closedMappingCheck, /submittedStoredMapping\.provider_id === providerId/);
  assert.match(closedMappingCheck, /providerMemberIdentity\(submittedStoredMapping\.provider_member_id\) === normalizedMemberId/);
  assert.match(closedMappingCheck, /submittedStoredMapping\.workforce_id === workforceId/);
  assert.match(closedMappingCheck, /sourceColumn && sourceProfileId/);
  assert.match(closedMappingResult, /if \(expectedReplacementId\)/);
  assert.match(closedMappingResult, /confirmation: null/);
  assert.match(closedMappingResult, /currentMappingLocationDriftEdit: true/);
});

test("the final save guard uses the same fail-closed period overlap rule", () => {
  assert.match(saveRow, /if \(!mappingId && !confirmedReplacementMappingId && !options\.keepExistingLocationMappingId\)/);
  assert.match(saveRow, /select\("id, station_id, effective_from"\)/);
  assert.match(saveRow, /\.eq\("status", "active"\)/);
  assert.match(saveRow, /existingCurrentMappings \?\? \[\]\)\.find\(\(mapping\) =>[\s\S]*?currentProviderMappingOverlapsRequestedPeriod\(mapping\.effective_from, effectiveFrom, effectiveTo \?\? ""\)/);
});

test("a confirmed replacement reaches the atomic replacement RPC instead of the duplicate-active preflight", () => {
  const duplicateActiveGuard = saveRow.slice(
    saveRow.indexOf("if (!mappingId && !confirmedReplacementMappingId && !options.keepExistingLocationMappingId)"),
    saveRow.indexOf("const dropxName", saveRow.indexOf("if (!mappingId && !confirmedReplacementMappingId && !options.keepExistingLocationMappingId)"))
  );

  assert.match(saveRow, /replacementMappingId && replacementMappingId !== confirmedReplacementMappingId/);
  assert.match(actions, /confirmedReplacementMappingId: replacementState\.locationRemap\?\.mappingId \?\? replacementState\.ownerReplacement\?\.mappingId \?\? null/);
  assert.match(duplicateActiveGuard, /An active mapping already exists/);
  assert.match(saveRow, /replacementMappingId\s*\?[\s\S]*?rpc\("workforce_replace_joining_mapping"/);
});

test("the inline response reloads the exact period that was saved", () => {
  assert.match(actions, /const savedProviderId = rowRequired\(formData, index, "provider_id", "Provider"\)/);
  assert.match(actions, /const savedEffectiveFrom = rowRequired\(formData, index, "effective_from", "Effective from"\)/);
  assert.match(actions, /const savedEffectiveTo = rowValue\(formData, index, "effective_to"\)/);
  assert.match(actions, /\.eq\("provider_id", savedProviderId\)/);
  assert.match(actions, /\.eq\("effective_from", savedEffectiveFrom\)/);
  assert.match(actions, /savedEffectiveTo[\s\S]*?savedMappingQuery\.eq\("effective_to", savedEffectiveTo\)[\s\S]*?savedMappingQuery\.is\("effective_to", null\)/);
});

test("an inactive method is reusable only from an exact canonical Keep-all anchor", () => {
  assert.match(saveRow, /select\("id, code, is_active, production_threshold_config/);
  assert.match(saveRow, /if \(paymentMethod\.is_active !== true\)/);
  assert.match(saveRow, /sourceType !== "workforce" \|\| !keepMappingId/);
  assert.match(saveRow, /keepAnchor\.station_id === canonicalWorker\.location_id/);
  assert.match(saveRow, /keepAnchor\.station_id !== stationId/);
  assert.match(saveRow, /keepAnchor\.provider_id === submittedProviderId/);
  assert.match(saveRow, /providerMemberIdentity\(keepAnchor\.provider_member_id\) === providerMemberIdentity\(providerMemberId\)/);
  assert.match(saveRow, /keepAnchor\.payment_method_id === paymentMethodId/);
  assert.match(saveRow, /keepAnchor\.status === "active" && !keepAnchor\.effective_to/);
  assert.match(saveRow, /keepAnchor\.status === "closed" && Boolean\(keepAnchor\.effective_to\)/);
  assert.match(saveRow, /canonicalKeepAnchor/);
  assert.match(saveRow, /providerFirstMappingPeriodContains\([\s\S]*?effectiveFrom,[\s\S]*?effectiveTo \?\? ""/);
  assert.match(saveRow, /historical Keep-all anchor is outside your allocated locations/);
});
