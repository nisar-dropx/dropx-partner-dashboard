import assert from "node:assert/strict";
import test from "node:test";
import { asLatLng, isValidGeo } from "./cortex-geo.ts";

test("isValidGeo accepts India-range coordinates", () => {
  assert.equal(isValidGeo(28.6139, 77.209), true);
  assert.equal(isValidGeo(8.5241, 76.9366), true);
});

test("isValidGeo rejects missing, infinite, and out-of-range values", () => {
  assert.equal(isValidGeo(null, 77), false);
  assert.equal(isValidGeo(28, null), false);
  assert.equal(isValidGeo(undefined, undefined), false);
  assert.equal(isValidGeo(Number.NaN, 77), false);
  assert.equal(isValidGeo(28, Number.POSITIVE_INFINITY), false);
  assert.equal(isValidGeo(91, 77), false);
  assert.equal(isValidGeo(28, 181), false);
  assert.equal(isValidGeo(-91, 0), false);
});

test("asLatLng coerces numeric strings and rejects junk", () => {
  assert.deepEqual(asLatLng("12.97", "77.59"), [12.97, 77.59]);
  assert.equal(asLatLng("abc", "77"), null);
  assert.equal(asLatLng(12.97, null), null);
});
