import assert from "node:assert/strict";
import test from "node:test";
import {
  asLatLng,
  cleanGpsTrail,
  completionPct,
  isValidGeo,
  pointAtTime,
  trailSegments,
  trailUpTo,
} from "./cortex-geo.ts";

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

test("completionPct uses delivered over total and falls back to components", () => {
  assert.equal(completionPct(40, 0, 16, 56), 71);
  assert.equal(completionPct(40, 0, 16, 0), 71);
  assert.equal(completionPct(0, 0, 0, 0), 0);
  assert.equal(completionPct(10, 0, 0, 10), 100);
});

test("cleanGpsTrail keeps chronological points and drops impossible spikes", () => {
  const day = "2026-10-30";
  const start = Date.parse(`${day}T00:00:00+05:30`);
  const rows = [
    {
      transporterId: "T1",
      epochTimestamp: start + 8 * 3600000,
      geocode: { latitude: 14.15, longitude: 79.85 },
    },
    {
      transporterId: "T1",
      epochTimestamp: start + 8 * 3600000 + 5000,
      geocode: { latitude: 14.1502, longitude: 79.8501 },
    },
    {
      transporterId: "OTHER",
      epochTimestamp: start + 8 * 3600000 + 10000,
      geocode: { latitude: 14.16, longitude: 79.86 },
    },
  ];
  const trail = cleanGpsTrail(rows, "T1", day);
  assert.equal(trail.length, 2);
  assert.deepEqual(trail[0].point, [14.15, 79.85]);
});

test("trailSegments breaks on large time gaps instead of air-bridging", () => {
  const a = { point: [14.15, 79.85], time: 1_000_000 };
  const b = { point: [14.151, 79.851], time: 1_010_000 };
  const c = { point: [14.2, 79.9], time: 1_200_000 };
  const d = { point: [14.201, 79.901], time: 1_210_000 };
  const segments = trailSegments([a, b, c, d]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 2);
  assert.equal(segments[1].length, 2);
});

test("pointAtTime and trailUpTo interpolate along the GPS trail", () => {
  const trail = [
    { point: [14, 79], time: 1000 },
    { point: [15, 80], time: 3000 },
  ];
  assert.deepEqual(pointAtTime(trail, 2000), [14.5, 79.5]);
  const partial = trailUpTo(trail, 2000);
  assert.equal(partial.length, 2);
  assert.deepEqual(partial[1].point, [14.5, 79.5]);
});
