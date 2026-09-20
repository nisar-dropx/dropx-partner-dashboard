import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./payment-shipment-count.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
new Function("exports", "module", code)(module.exports, module);
const { paymentShipmentCount } = module.exports;
const answer = (value, label = "Tracking IDs", type = "textarea") => ({
  answer_value: value,
  payment_head_questions: { question_text: label, answer_type: type }
});

test("counts three saved tracking IDs in common pasted formats", () => {
  for (const separator of ["\n", "\r\n", ",", ";", "\t", " ", ",\n\n"]) {
    assert.equal(paymentShipmentCount([answer(["T001", "T002", "T003"].join(separator))]), 3);
  }
});

test("blank entries and repeated IDs do not inflate shipment totals", () => {
  const saved = Object.freeze(answer("\n T001, T002;;\nT001\tT003, \n"));
  assert.equal(paymentShipmentCount([saved, answer("T002\nT004")]), 4);
  assert.equal(saved.answer_value, "\n T001, T002;;\nT001\tT003, \n");
  for (const value of [null, "", " \r\n,;\t"]) {
    assert.equal(paymentShipmentCount([answer(value)]), 0);
  }
});

test("recognizes tracking field labels and preserves IDs with leading zeros and hyphens", () => {
  for (const label of ["Tracking IDs", "TRACKING ID'S *", " Tracking ID ", "Tracking_IDs", "Tracking Numbers:", "Shipment Tracking IDs"]) {
    assert.equal(paymentShipmentCount([answer("000123 AB-456", label, "text")]), 2);
  }
});

test("does not invent shipment counts from unrelated fields or attachments", () => {
  const unrelated = [
    answer("3", "Number of Tracking IDs", "number"),
    answer("Please check Tracking IDs", "Remarks"),
    answer("shipments.png", "Shipments timestamp photo", "file"),
    answer("tracking.csv", "Tracking IDs", "file"),
    { answer_value: "T001 T002", payment_head_questions: null }
  ];
  assert.equal(paymentShipmentCount([]), null);
  assert.equal(paymentShipmentCount(unrelated), null);
  assert.equal(paymentShipmentCount([...unrelated, answer("T001 T002 T003")]), 3);
});

test("recalculates returned requests from their current saved tracking IDs", () => {
  assert.equal(paymentShipmentCount([answer("T001 T002 T003")]), 3);
  assert.equal(paymentShipmentCount([answer("T001 T003")]), 2);
});
