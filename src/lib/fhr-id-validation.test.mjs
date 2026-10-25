import assert from "node:assert/strict";
import test from "node:test";
import { fhrIdValidationMessage } from "./fhr-id-validation.ts";

test("FHR accepts exactly 12 ASCII digits and preserves leading zeroes", () => {
  for (const id of ["012345678901", "123456789012", "000000000001"]) {
    assert.equal(fhrIdValidationMessage(id), "");
  }
});

test("blank and incomplete IDs explain how to continue", () => {
  assert.match(fhrIdValidationMessage(""), /mandatory 12-digit/);
  for (let length = 1; length < 12; length++) {
    assert.match(fhrIdValidationMessage("1".repeat(length)), new RegExp(`${length}/12 entered`));
  }
});

test("overlong pasted IDs are rejected rather than truncated into a different ID", () => {
  assert.match(fhrIdValidationMessage("1234567890123"), /exactly 12 digits \(13 entered\)/);
});

test("names, URLs, whitespace, numeric notation and non-ASCII digits are rejected", () => {
  for (const id of ["Test Name", "12345678901A", " 123456789012", "123456789012 ", "123 456789012", "1234567890.1", "1.2345678e11", "+12345678901", "１２３４５６７８９０１２", "https://casper.example/123456789012"]) {
    assert.match(fhrIdValidationMessage(id), /numbers only/);
  }
});
