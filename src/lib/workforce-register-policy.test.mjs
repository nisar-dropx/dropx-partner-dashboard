import { test } from "node:test";
import assert from "node:assert/strict";
import { workforceRegisterLocations, workforceStationPolicy, workforceStationEmailError } from "./workforce-register-policy.ts";
const station = (id, model, provider = "Amazon", parent) => ({ id, station_code: id, parent_station_id: parent, providers: { name: provider }, location_models: { code: model } });
for (const model of ["EDSP", "XPT", "AMXL"]) test(`${model} requires station email, accepting any domain and case`, () => {
  assert.equal(workforceStationPolicy(station("KOZA", model)).requiresStationEmail, true);
  for (const email of ["Akshay.KOZA@outlook.com", "akshay.koza@gmail.com", "a.b.KoZa@example.org"]) assert.equal(workforceStationEmailError(email, "KOZA", true), null);
  for (const email of ["akshay@gmail.com", "akshay.ktub@gmail.com", "akshay.koza.other@gmail.com", ".koza@gmail.com", "a.koza@bad"]) assert.ok(workforceStationEmailError(email, "KOZA", true));
});
test("Flipkart personal email remains valid", () => {
  for (const model of ["ODH", "MDH"]) assert.equal(workforceStationPolicy(station("PHN", model, "Flipkart")).requiresStationEmail, false);
  assert.equal(workforceStationEmailError("personal@example.com", "PHN", false), null);
});
test("station scope includes child XPT but not sibling, parent or Amazon Now", () => {
  const stations = [station("PEUA", "EDSP"), station("KGQE", "XPT", "Amazon", "PEUA"), station("NOW1", "NOW", "Amazon", "PEUA"), station("KOZA", "EDSP")];
  assert.deepEqual(workforceRegisterLocations(stations, { hasAllLocationAccess: false, locationScopeIds: ["PEUA"] }).map(s => s.id), ["PEUA", "KGQE"]);
  assert.deepEqual(workforceRegisterLocations(stations, { hasAllLocationAccess: false, locationScopeIds: ["KGQE"] }).map(s => s.id), ["KGQE"]);
  assert.deepEqual(workforceRegisterLocations(stations, { hasAllLocationAccess: true, locationScopeIds: [] }).map(s => s.id), ["PEUA", "KGQE", "KOZA"]);
  assert.deepEqual(workforceRegisterLocations(stations, { hasAllLocationAccess: false, locationScopeIds: [] }), []);
});
test("Now policy tolerates relationship arrays and canonical model aliases", () => {
  assert.equal(workforceStationPolicy({ id: "n", providers: [{ name: "Amazon" }], location_models: [{ code: "Amazon Now" }] }).excluded, true);
});
