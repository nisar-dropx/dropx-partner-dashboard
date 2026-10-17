import assert from "node:assert/strict";
import test from "node:test";
import { pageWindow } from "./page-window.ts";
test("page window keeps first, last and neighbours with gaps", () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 5), [1, 2, "…", 5]);
  assert.deepEqual(pageWindow(5, 10), [1, "…", 4, 5, 6, "…", 10]);
  assert.deepEqual(pageWindow(10, 10), [1, "…", 9, 10]);
  assert.deepEqual(pageWindow(2, 3), [1, 2, 3]);
});
