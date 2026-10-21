import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("./payment-allocation-history-button.tsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("history exposes period clearing only through the explicit permission and callback", () => {
  assert.match(component, /canClearMappingPeriod\?: boolean/);
  assert.match(component, /onClearMappingPeriod\?: \(entry: PaymentAllocationHistoryEntry\) => Promise<\{ ok: boolean; message: string \}>/);
  assert.match(component, /\(canClearMappingPeriod \|\| clearTargetId === entry\.id \|\| clearingEntryId === entry\.id\) && onClearMappingPeriod && removableSavedPeriod/);
  assert.match(component, /const removableSavedPeriod = Boolean\(entry\.updatedAt\)[\s\S]*?entry\.storedStatus\.trim\(\)\.toLowerCase\(\) !== "cancelled"/);
  assert.match(component, /Past, current and scheduled periods are all removable/);
  assert.match(component, />Remove mapping<\/button>/);
});

test("period clearing confirms the exact range and explains its bounded effect", () => {
  assert.match(component, /readableDate\(entry\.effectiveFrom\).*readableDate\(entry\.effectiveTo\)/s);
  assert.match(component, /Remove the \{locationLabel\} mapping for this period\?/);
  assert.match(component, /Both the DropX mapping and the payment method\/rates for only this location-period will become unmapped\./);
  assert.match(component, /History remains available, and all other locations and periods remain unchanged\./);
  assert.match(component, /Removal is blocked only when this period has a published or locked payment/);
  assert.match(component, />Remove this period<|"Remove this period"/);
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

test("mapping-period removal actions retain a visible danger treatment", () => {
  assert.match(globalStyles, /--danger:\s*#[0-9a-f]{3,8}\s*;/i);
  assert.match(globalStyles, /\.button\.danger\s*\{[\s\S]*?background:\s*var\(--danger\)[\s\S]*?color:\s*#fff\s*;/i);
  assert.match(component, /className="button danger compact"[\s\S]*?>Remove mapping<\/button>/);
  assert.match(component, /className="button danger compact"[\s\S]*?"Remove this period"/);
});
