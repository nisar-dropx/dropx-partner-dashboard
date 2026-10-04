import { test } from "node:test";
import assert from "node:assert/strict";
import { workforceProfileStatus, workforceRegisterLocations, workforceStationPolicy, workforceStationEmailError } from "./workforce-register-policy.ts";
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

test("onboarding status takes precedence over the activation flag", () => {
  assert.equal(workforceProfileStatus({ onboarding_status: "pending", lifecycle_status: "onboarding", is_active: false }), "Pending");
  assert.equal(workforceProfileStatus({ onboarding_status: "under_review", is_active: false }), "Under Review");
  assert.equal(workforceProfileStatus({ onboarding_status: "returned", is_active: false }), "Returned");
  assert.equal(workforceProfileStatus({ onboarding_status: "active", is_active: true }), "Active");
  assert.equal(workforceProfileStatus({ onboarding_status: "active", is_active: false }), "Inactive");
  assert.equal(workforceProfileStatus({ onboarding_status: "pending", people_lifecycle_status: "offboarded", is_active: false }), "Offboarded");
});

import { pendingWorkforceRegistration, activeWorkforceRegistration, registrationFilledFields, registrationProgress } from "./workforce-registration-progress.ts";
test("Ops excludes HO locations by model, including assigned locations", () => {
  const stations = [station("HO_KL", "DROPX_HO", "DropX"), station("KOZA", "EDSP")];
  assert.deepEqual(workforceRegisterLocations(stations, { hasAllLocationAccess: true, locationScopeIds: [] }).map(s => s.id), ["KOZA"]);
});
test("pending registration and active IDs are separate from activation flags", () => {
  assert.equal(pendingWorkforceRegistration({ onboarding_status: "pending", is_active: true }), true);
  assert.equal(pendingWorkforceRegistration({ onboarding_status: "returned", is_active: false }), true);
  for (const onboarding_status of ["active", "under_review", "approved", "rejected", "cancelled"]) assert.equal(pendingWorkforceRegistration({ onboarding_status, is_active: true }), false);
  for (const onboarding_status of ["pending", "returned", "under_review", "approved", "rejected", "cancelled"]) {
    assert.equal(activeWorkforceRegistration({ onboarding_status, is_active: true }), false);
  }
  assert.equal(activeWorkforceRegistration({ onboarding_status: "active", is_active: false }), false);
  assert.equal(activeWorkforceRegistration({ onboarding_status: "active", is_active: true }), true);
  for (const state of [{ deleted_at: "2026-10-03" }, { people_lifecycle_status: "offboarded" }, { people_lifecycle_status: "suspended" }]) {
    assert.equal(activeWorkforceRegistration({ onboarding_status: "active", is_active: true, ...state }), false);
    assert.equal(pendingWorkforceRegistration({ onboarding_status: "pending", ...state }), false);
  }
});
test("saved draft values and files override stored profile completion, without exposing values", () => {
  const flags = registrationFilledFields({ postal_pin: "123456", ifsc_code: "BANK123", aadhaar_front_path: "saved/file", is_handicapped: false }, { draft_data: { pincode: "", ifsc: "NEW123", gender: "Female" }, file_paths: { aadhaar_front: "", profile_photo: "draft/file" } });
  assert.equal(flags.pincode, false);
  assert.equal(flags.ifsc, true);
  assert.equal(flags.aadhaar_front, false);
  assert.equal(flags.profile_photo, true);
  assert.equal(flags.is_handicapped, true);
  assert.ok(Object.values(flags).every(value => typeof value === "boolean"));
});
test("progress counts only configured fields and distinguishes required missing fields", () => {
  const result = registrationProgress({ gender: true, phone: true, bank: false }, { enabled: ["gender", "bank"], required: ["bank"] }, [
    { key: "gender", label: "Gender", group: "Personal" }, { key: "phone", label: "Phone", group: "Personal" }, { key: "bank", label: "Bank account", group: "Bank" }
  ]);
  assert.equal(result.filled, 1); assert.equal(result.total, 2); assert.equal(result.missingRequired, 1);
  assert.deepEqual(result.groups[1].missing, ["Bank account"]);
});
