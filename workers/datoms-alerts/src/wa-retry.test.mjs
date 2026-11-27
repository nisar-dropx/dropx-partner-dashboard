import assert from "node:assert/strict";
import test from "node:test";
import { isWhatsAppLevel } from "./filter.mjs";

function alertFullyHandled(state) {
  if (!state) return false;
  if (state.notified_at) return true;
  return !isWhatsAppLevel(state.level);
}

test("L2/L3 stored without notified_at remain open for WA retry", () => {
  assert.equal(alertFullyHandled({ level: "L2", notified_at: null }), false);
  assert.equal(alertFullyHandled({ level: "L3", notified_at: null }), false);
});

test("notified rows and L1-only rows are fully handled", () => {
  assert.equal(alertFullyHandled({ level: "L2", notified_at: "2026-11-27T12:00:00Z" }), true);
  assert.equal(alertFullyHandled({ level: "L1", notified_at: null }), true);
});
