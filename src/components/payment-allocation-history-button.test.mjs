import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("./payment-allocation-history-button.tsx", import.meta.url), "utf8");

test("history exposes period clearing only through the explicit permission and callback", () => {
  assert.match(component, /canClearMappingPeriod\?: boolean/);
  assert.match(component, /onClearMappingPeriod\?: \(entry: PaymentAllocationHistoryEntry\) => Promise<\{ ok: boolean; message: string \}>/);
  assert.match(component, /\(canClearMappingPeriod \|\| clearTargetId === entry\.id \|\| clearingEntryId === entry\.id\) && onClearMappingPeriod/);
  assert.match(component, /Boolean\(entry\.updatedAt\)/);
  assert.match(component, />Clear mapping<\/button>/);
});

test("period clearing confirms the exact range and explains its bounded effect", () => {
  assert.match(component, /readableDate\(entry\.effectiveFrom\).*readableDate\(entry\.effectiveTo\)/s);
  assert.match(component, /Clear the \{locationLabel\} location-period\?/);
  assert.match(component, /Both the DropX mapping and the payment method\/rates for only this location-period will become unmapped\./);
  assert.match(component, /History remains available, and all other locations and periods remain unchanged\./);
  assert.match(component, />Clear and save<|"Clear and save"/);
  assert.doesNotMatch(component, /(?:window\.)?confirm\s*\(/);
});

test("the modal catches save failures and cannot close while clearing", () => {
  assert.match(component, /const result = await onClearMappingPeriod\(entry\)/);
  assert.match(component, /if \(!result\.ok\).*setClearError\(result\.message/s);
  assert.match(component, /setClearError\(error instanceof Error \? error\.message/);
  assert.match(component, /if \(clearPendingRef\.current\) return/);
  assert.match(component, /disabled=\{Boolean\(clearingEntryId\)\} onClick=\{closeModal\}/);
  assert.match(component, /aria-busy=\{clearingEntryId === entry\.id\}/);
  assert.match(component, /role="alert">\{clearError\}/);
});
