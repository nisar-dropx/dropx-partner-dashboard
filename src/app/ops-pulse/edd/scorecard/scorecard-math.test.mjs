import assert from "node:assert/strict";
import test from "node:test";
import { stationScore } from "./scorecard-math.ts";
const s = (x = {}) => ({ station: "A", days: 7, das: 10, delivered: 700, assigned: 0, returns: 30, da_days: 70, prev_delivered: 1000, prev_assigned: 0, prev_da_days: 70, trend: null, ...x });
test("scores productivity, change, returns and flags", () => {
  const r = stationScore(s());
  assert.equal(r.perDa, 10); assert.equal(Math.round(r.change), -30); assert.equal(r.returnRate, 30 / 730 * 100); assert.equal(r.flag, "deliveries down sharply");
  assert.equal(stationScore(s({ prev_delivered: 0, prev_da_days: 0 })).change, null);
  assert.equal(stationScore(s({ prev_delivered: 720, prev_da_days: 50, delivered: 700, returns: 0 })).flag, "productivity down");
  assert.equal(stationScore(s({ prev_delivered: 700, returns: 100 })).flag, "high returns");
  assert.deepEqual(stationScore(s({ delivered: 0, returns: 0, da_days: 0 })).perDa, 0);
});
