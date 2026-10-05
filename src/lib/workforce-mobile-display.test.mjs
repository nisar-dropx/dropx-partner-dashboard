import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkforceMobile } from "./workforce-mobile-display.ts";

test("workforce mobile display includes its stored country code", () => {
  assert.equal(formatWorkforceMobile("91", "9853445558"), "+91 9853445558");
  assert.equal(formatWorkforceMobile("+971", "501234567"), "+971 501234567");
});

test("workforce mobile display defaults a missing country code without duplicating plus signs", () => {
  assert.equal(formatWorkforceMobile(null, "9853445558"), "+91 9853445558");
  assert.equal(formatWorkforceMobile(" +91 ", "9853445558"), "+91 9853445558");
});

test("workforce mobile display preserves the empty-value placeholder", () => {
  assert.equal(formatWorkforceMobile("91", null), "-");
  assert.equal(formatWorkforceMobile("91", "   "), "-");
});
