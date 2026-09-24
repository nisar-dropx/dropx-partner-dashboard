import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/wheelseye-history.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports);
const date = '2026-09-23', start = Date.parse(`${date}T00:00:00+05:30`) / 1000, vehicle = 'TEST001';
const point = (second, lon = 75, speed = 36) => ({ latitude: 11, longitude: lon, speed, dttimeInEpoch: start + second, vehicleName: vehicle });
const calc = points => exports.calculateWheelseyeMovement(points, vehicle, date);
const clean = Array.from({ length: 100 }, (_, index) => point(index * 10, 75 + index * 0.0009));
const expected = calc(clean);
assert.equal(expected.summary.distanceReliable, true);
assert.ok(expected.summary.km > 9 && expected.summary.km < 10);
// Real failure pattern: the moving track is interleaved with old stopped coordinates.
const cached = clean.flatMap(p => [p, { ...point(p.dttimeInEpoch - start + 2, 74.95, 0), ignition: 0 }]);
const corrected = calc(cached);
assert.equal(corrected.summary.km, expected.summary.km);
assert.equal(corrected.summary.distanceReliable, true);
assert.equal(corrected.summary.quality, 'filtered');
assert.equal(corrected.summary.stationaryPointCount, 100);
assert.ok(corrected.summary.rawKm > corrected.summary.km * 10);
assert.deepEqual(corrected.points, expected.points, 'Tracking must use the same corrected trajectory');
assert.equal(calc([...cached].reverse()).summary.km, expected.summary.km, 'Ordering cannot change distance');
assert.equal(calc(clean.map(p => ({ ...p, dttimeInEpoch: p.dttimeInEpoch * 1000 }))).summary.km, expected.summary.km);
// One recoverable spike among a continuous moving track is filtered; no whole-day rejection.
const spike = [...clean]; spike[50] = { ...spike[50], latitude: 14 };
assert.equal(calc(spike).summary.km, expected.summary.km);
assert.equal(calc(spike).summary.quality, 'filtered');
assert.equal(calc(spike).summary.rejectedPointCount, 1);
// Do not "fix" an unresolved discontinuity or invent kilometres through a long gap.
const split = clean.map((p, i) => i < 50 ? p : { ...p, latitude: 14 });
assert.equal(calc(split).summary.distanceReliable, false);
assert.equal(calc([point(0), point(3600, 75.2)]).summary.distanceReliable, false);
// A genuine stop near the same position preserves the next trip; moving minutes exclude night-time parking.
assert.equal(calc([point(0), point(600, 75.0001)]).summary.distanceReliable, false, 'A recording gap is not proof of a stop');
assert.equal(calc([point(0), point(100,75,0), point(500,75,0), point(600,75.0001)]).summary.distanceReliable, true);
assert.equal(calc([point(0, 75, 0), point(3600, 75.00001, 0)]).summary.km, 0);
assert.equal(calc([point(0, 75, 0), point(3600, 75.00001, 0)]).summary.distanceReliable, true);
assert.equal(calc([point(0, 75, 0), point(3600, 75.1, 0)]).summary.distanceReliable, false, 'Zero speed on a changing track must not become a false stationary day');
assert.equal(calc([point(0)]).summary.distanceReliable, false);
assert.equal(calc([]).summary.pointCount, 0);
assert.equal(calc(clean.map(p => ({ ...p, speed: undefined }))).summary.distanceReliable, false);
// Reject invalid / other-day / other-vehicle points before calculating any distance.
const dirty = [...clean, {...point(15), latitude: null}, {...point(15), latitude: 999}, {...point(15), latitude: 0, longitude: 0}, point(-1), point(86400), {...point(15), vehicleName:'OTHER'}];
assert.equal(calc(dirty).summary.km, expected.summary.km);
assert.equal(calc(dirty).summary.rejectedPointCount, 6);
assert.equal(calc([...clean, {...clean[50], speed:0, longitude:74}]).summary.km, expected.summary.km);
assert.equal(calc([...clean, {...clean[50], longitude:74}]).summary.distanceReliable, false, 'Conflicting moving fixes at one timestamp need review');
assert.throws(() => exports.calculateWheelseyeMovement([], vehicle, '2026-02-30'), /valid movement date/);
const originalFetch = globalThis.fetch;
try {
 globalThis.fetch = async () => ({ok:true,json:async()=>({Vehicle:cached})});
 assert.equal((await exports.loadWheelseyeMovement('test', vehicle, date)).summary.km, expected.summary.km);
 globalThis.fetch = async () => ({ok:true,json:async()=>({data:[]})});
 await assert.rejects(exports.loadWheelseyeMovement('test', vehicle, date), /unexpected/);
} finally { globalThis.fetch=originalFetch; }
console.log('WheelsEye distance: cached stationary interleaving, recoverable spikes, recording gaps, stationary days, dates, vehicle matching, timestamps and shared map trajectory passed.');
