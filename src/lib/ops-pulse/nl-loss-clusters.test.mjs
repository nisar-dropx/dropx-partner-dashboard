import assert from "node:assert/strict";
import test from "node:test";
import { nlPeopleClusters } from "./nl-loss-clusters.ts";
import { resolvePeopleOperationalHierarchy, resolveStationResponsibilityRoots } from "../people-operational-hierarchy-core.ts";

const assignment = (id, personId, name, location, code) => ({
  id, personId, displayName: name, locationId: location,
  designationCode: code, designationName: code, positionTitle: code,
});
const owner = (personId, name) => ({ personId, name });
const hierarchy = (clusterManagers = [], areaOperationsManagers = []) => ({ clusterManagers, areaOperationsManagers });

test("NL uses only authorized stations' current People owners, not stale station text", () => {
  const result = nlPeopleClusters([{ id: "A", cluster: "Former manager" }], new Map([
    ["A", hierarchy([owner("p1", "Current manager")])],
    ["B", hierarchy([owner("p2", "Outside scope")])],
  ]));
  assert.deepEqual(result.options, [{ value: "cm:p1", label: "Current manager" }]);
  assert.equal(result.byStation.get("A").cluster, "Current manager");
  assert.equal(result.byStation.has("B"), false);
});

test("People IDs distinguish identical names and multiple managers retain one station row", () => {
  const result = nlPeopleClusters([{ id: "A" }, { id: "B" }], new Map([
    ["A", hierarchy([owner("p1", "Manager"), owner("p2", "Manager"), owner("p1", "Manager")])],
    ["B", hierarchy([owner("p1", "Manager")])],
  ]));
  assert.equal(result.options.length, 2);
  assert.equal(result.byStation.size, 2);
  assert.deepEqual(result.byStation.get("A").clusterKeys, ["cm:p1", "cm:p2"]);
});

test("AOM fallback is explicit; unmapped People stations never get legacy names", () => {
  const result = nlPeopleClusters([{ id: "A" }, { id: "B" }, { id: "C" }], new Map([
    ["A", hierarchy([], [owner("p1", "Area manager")])],
    ["B", hierarchy([owner("p2", "Cluster manager")], [owner("p1", "Area manager")])],
  ]));
  assert.deepEqual(result.byStation.get("A"), { cluster: "Area manager (AOM)", clusterKeys: ["aom:p1"] });
  assert.deepEqual(result.byStation.get("B").clusterKeys, ["cm:p2"]);
  assert.deepEqual(result.byStation.get("C"), { cluster: "Not mapped in People", clusterKeys: ["unmapped"] });
});

test("direct People station responsibilities resolve to a promoted current role even without local staff", () => {
  const assignments = [assignment("new-aom", "p1", "Promoted manager", "HO", "AOM")];
  const roots = resolveStationResponsibilityRoots([
    { stationId: "A", personId: "p1" },
    { stationId: "B", personId: "inactive-person" },
  ], assignments);
  const result = resolvePeopleOperationalHierarchy(["A", "B"], assignments, [], roots);
  assert.deepEqual(roots.get("A"), ["new-aom"]);
  assert.equal(result.get("A").areaOperationsManagers[0].name, "Promoted manager");
  assert.deepEqual(result.get("B").clusterManagers, []);
  assert.deepEqual(result.get("B").areaOperationsManagers, []);
});

test("explicit roots deduplicate local roots, ignore ended assignments and non-manager responsibilities", () => {
  const assignments = [assignment("cm", "p1", "Manager", "A", "CLM"), assignment("finance", "p2", "Accounts", "HO", "ACE")];
  const roots = resolveStationResponsibilityRoots([
    { stationId: "A", personId: "p1" }, { stationId: "A", personId: "p1" }, { stationId: "A", personId: "p2" },
  ], assignments);
  roots.get("A").push("ended-cm");
  const result = resolvePeopleOperationalHierarchy(["A"], assignments, [], roots);
  assert.equal(result.get("A").clusterManagers.length, 1);
  assert.equal(result.get("A").clusterManagers[0].supportCount, 1);
});
