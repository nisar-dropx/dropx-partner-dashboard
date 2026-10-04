import assert from "node:assert/strict";
import test from "node:test";
import {
  movePaymentField,
  movePaymentFieldByOffset,
  normalizePaymentFieldCode,
  normalizePaymentFieldOrder,
  paymentComponentOrderMap,
  sortByPaymentFieldOrder,
  togglePaymentFieldSelection
} from "./payment-field-order.ts";

test("payment component order maps normalized codes to configured ranks", () => {
  const order = paymentComponentOrderMap([
    { component_code: " field_b ", sort_order: "2" },
    { component_code: "FIELD_A", sort_order: 1 },
    { component_code: "field_c" },
    { component_code: "FIELD_A", sort_order: 99 },
    { component_code: "  ", sort_order: 4 }
  ]);

  assert.deepEqual([...order.entries()], [["FIELD_B", 2], ["FIELD_A", 1], ["FIELD_C", 2]]);
  assert.equal(normalizePaymentFieldCode(" field_a "), "FIELD_A");
});

test("normalizePaymentFieldOrder preserves first-seen order while removing blanks and duplicates", () => {
  const source = [" field-b ", "field-a", "field-b", "", "   ", "field-c", "field-a"];

  assert.deepEqual(normalizePaymentFieldOrder(source), ["field-b", "field-a", "field-c"]);
  assert.deepEqual(source, [" field-b ", "field-a", "field-b", "", "   ", "field-c", "field-a"]);
});

test("normalizePaymentFieldOrder filters against valid IDs without adopting the valid-ID order", () => {
  assert.deepEqual(
    normalizePaymentFieldOrder(
      ["field-c", "field-a", "missing", "field-b"],
      new Set(["field-a", " field-b ", "field-c"])
    ),
    ["field-c", "field-a", "field-b"]
  );
  assert.deepEqual(normalizePaymentFieldOrder(["a", "b"], []), []);
});

test("togglePaymentFieldSelection appends a new ID and removes an existing ID in place", () => {
  const selected = ["field-b", "field-a", "field-c"];

  assert.deepEqual(togglePaymentFieldSelection(selected, "field-d"), ["field-b", "field-a", "field-c", "field-d"]);
  assert.deepEqual(togglePaymentFieldSelection(selected, "field-a"), ["field-b", "field-c"]);
  assert.deepEqual(selected, ["field-b", "field-a", "field-c"]);
});

test("togglePaymentFieldSelection normalizes dirty input and ignores a blank requested ID", () => {
  assert.deepEqual(togglePaymentFieldSelection([" a ", "a", "b", ""], " a "), ["b"]);
  assert.deepEqual(togglePaymentFieldSelection([" a ", "a", "b", ""], "   "), ["a", "b"]);
});

test("movePaymentField moves an ID before the target by default", () => {
  assert.deepEqual(
    movePaymentField(["field-a", "field-b", "field-c", "field-d"], "field-d", "field-b"),
    ["field-a", "field-d", "field-b", "field-c"]
  );
  assert.deepEqual(
    movePaymentField(["field-a", "field-b", "field-c", "field-d"], "field-a", "field-c"),
    ["field-b", "field-a", "field-c", "field-d"]
  );
});

test("movePaymentField supports placement after the target", () => {
  assert.deepEqual(
    movePaymentField(["field-a", "field-b", "field-c", "field-d"], "field-a", "field-c", "after"),
    ["field-b", "field-c", "field-a", "field-d"]
  );
  assert.deepEqual(
    movePaymentField(["field-a", "field-b", "field-c", "field-d"], "field-d", "field-b", "after"),
    ["field-a", "field-b", "field-d", "field-c"]
  );
});

test("movePaymentField leaves normalized order unchanged for missing or identical IDs", () => {
  const dirtyOrder = ["field-a", "field-a", " field-b ", "field-c"];

  assert.deepEqual(movePaymentField(dirtyOrder, "missing", "field-b"), ["field-a", "field-b", "field-c"]);
  assert.deepEqual(movePaymentField(dirtyOrder, "field-a", "missing"), ["field-a", "field-b", "field-c"]);
  assert.deepEqual(movePaymentField(dirtyOrder, "field-b", "field-b", "after"), ["field-a", "field-b", "field-c"]);
});

test("movePaymentFieldByOffset moves relatively in either direction", () => {
  assert.deepEqual(
    movePaymentFieldByOffset(["field-a", "field-b", "field-c", "field-d"], "field-b", 2),
    ["field-a", "field-c", "field-d", "field-b"]
  );
  assert.deepEqual(
    movePaymentFieldByOffset(["field-a", "field-b", "field-c", "field-d"], "field-d", -2),
    ["field-a", "field-d", "field-b", "field-c"]
  );
});

test("movePaymentFieldByOffset truncates and clamps offsets and ignores invalid moves", () => {
  const order = ["field-a", "field-b", "field-c"];

  assert.deepEqual(movePaymentFieldByOffset(order, "field-b", 99), ["field-a", "field-c", "field-b"]);
  assert.deepEqual(movePaymentFieldByOffset(order, "field-b", -99), ["field-b", "field-a", "field-c"]);
  assert.deepEqual(movePaymentFieldByOffset(order, "field-b", 0.9), order);
  assert.deepEqual(movePaymentFieldByOffset(order, "missing", 1), order);
  assert.deepEqual(movePaymentFieldByOffset(order, "field-b", Number.NaN), order);
  assert.deepEqual(order, ["field-a", "field-b", "field-c"]);
});

test("sortByPaymentFieldOrder uses configured code ranks and a stable fallback", () => {
  const items = [
    { id: "unranked-1", code: "OTHER" },
    { id: "second-a", code: "B" },
    { id: "first", code: "A" },
    { id: "second-b", code: "B" },
    { id: "unranked-2", code: null }
  ];
  const result = sortByPaymentFieldOrder(items, new Map([["A", 1], ["B", 2]]), (item) => item.code);

  assert.deepEqual(result.map((item) => item.id), ["first", "second-a", "second-b", "unranked-1", "unranked-2"]);
  assert.deepEqual(items.map((item) => item.id), ["unranked-1", "second-a", "first", "second-b", "unranked-2"]);
});

test("sortByPaymentFieldOrder accepts record ranks and keeps equal, missing, or invalid ranks stable", () => {
  const items = [
    { id: "missing-a", code: "MISSING" },
    { id: "equal-a", code: "A" },
    { id: "invalid", code: "INVALID" },
    { id: "equal-b", code: "B" },
    { id: "missing-b", code: undefined },
    { id: "first", code: "FIRST" }
  ];
  const order = { A: 5, B: 5, FIRST: -1, INVALID: Number.POSITIVE_INFINITY };

  assert.deepEqual(
    sortByPaymentFieldOrder(items, order, (item) => item.code).map((item) => item.id),
    ["first", "equal-a", "equal-b", "missing-a", "invalid", "missing-b"]
  );
});

test("sortByPaymentFieldOrder preserves input order when no component code is ranked", () => {
  const items = [{ code: "C" }, { code: "A" }, { code: "B" }];

  assert.deepEqual(sortByPaymentFieldOrder(items, new Map(), (item) => item.code), items);
});
