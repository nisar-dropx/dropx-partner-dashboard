import { test } from "node:test";
import assert from "node:assert/strict";
import { currentLocationScopeIds, isCurrentLocation } from "./current-location-policy.ts";

test("current locations must be active and not hidden", () => {
  assert.equal(isCurrentLocation({ id: "active", is_active: true, hide_from_location_list: false }), true);
  assert.equal(isCurrentLocation({ id: "hidden", is_active: true, hide_from_location_list: true }), false);
  assert.equal(isCurrentLocation({ id: "inactive", is_active: false, hide_from_location_list: false }), false);
});

test("current scope drops unavailable stations and retains active children", () => {
  const locations = [
    { id: "parent", is_active: false, hide_from_location_list: false },
    { id: "child", parent_station_id: "parent", is_active: true, hide_from_location_list: false },
    { id: "hidden", is_active: true, hide_from_location_list: true },
    { id: "active", is_active: true, hide_from_location_list: false }
  ];
  assert.deepEqual(currentLocationScopeIds(locations, ["parent", "hidden", "active"]), ["child", "active"]);
});
