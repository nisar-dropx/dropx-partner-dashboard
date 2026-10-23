import assert from "node:assert/strict";
import test from "node:test";

import {
  designationPeopleModuleLabel,
  normalizeDesignationPeopleModule
} from "./designation-business-categories.ts";
import {
  designationProfileDestinationAllowed,
  designationProfileDestinationLabel,
  designationProfileDestinationsForModule,
  normalizeDesignationProfileDestination
} from "./designation-profile-destination.ts";

test("designation people modules accept only the two supported category modules", () => {
  assert.equal(normalizeDesignationPeopleModule(" DELIVERY_NETWORK "), "delivery_network");
  assert.equal(normalizeDesignationPeopleModule("people_HR"), "people_hr");
  assert.equal(normalizeDesignationPeopleModule("finance"), null);
  assert.equal(designationPeopleModuleLabel("delivery_network"), "Workforce");
  assert.equal(designationPeopleModuleLabel("people_hr"), "HR");
});

test("workforce designation categories expose only workforce profile destinations", () => {
  assert.deepEqual(
    designationProfileDestinationsForModule("delivery_network").map(({ value }) => value),
    ["workforce", "vendors"]
  );
  assert.equal(designationProfileDestinationAllowed("delivery_network", "workforce"), true);
  assert.equal(designationProfileDestinationAllowed("delivery_network", "vendors"), true);
  assert.equal(designationProfileDestinationAllowed("delivery_network", "employees"), false);
});

test("HR designation categories expose only HR profile destinations", () => {
  assert.deepEqual(
    designationProfileDestinationsForModule("people_hr").map(({ value }) => value),
    ["employees", "field_executives", "contractors", "workers"]
  );
  assert.equal(designationProfileDestinationAllowed("people_hr", "employees"), true);
  assert.equal(designationProfileDestinationAllowed("people_hr", "field_executives"), true);
  assert.equal(designationProfileDestinationAllowed("people_hr", "contractors"), true);
  assert.equal(designationProfileDestinationAllowed("people_hr", "workers"), true);
  assert.equal(designationProfileDestinationAllowed("people_hr", "workforce"), false);
});

test("profile destinations normalize submitted values and use safe display fallbacks", () => {
  assert.equal(normalizeDesignationProfileDestination(" FIELD_EXECUTIVES "), "field_executives");
  assert.equal(normalizeDesignationProfileDestination("unknown"), null);
  assert.equal(designationProfileDestinationLabel("contractors"), "Independent Contractors");
  assert.equal(designationProfileDestinationLabel("unknown"), "Not set");
});
