import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeamOrgView, teamOrgFamily } from "./team-org-core.ts";

const person = (id, managerId, title, location = null, extra = {}) => ({
  id, personId: `p-${id}`, managerId, name: id, code: null, title, designationCode: null,
  locationId: location ? `loc-${location}` : null, location, department: null, isTopLevel: false, ...extra
});
// nh > aom > cm1 > tl1 > (da1, da2) at PEUA; cm2 > tl2 > da3 at KOZA; aom2 > cm3 > tl3 at KTUB
const people = [
  person("nh", null, "National Head", null, { isTopLevel: true }),
  person("aom", "nh", "Area Operations Manager"),
  person("cm1", "aom", "Cluster Manager"),
  person("tl1", "cm1", "Team Lead", "PEUA"),
  person("da1", "tl1", "Station Support Associate", "PEUA"),
  person("da2", "tl1", "Station Support Associate", "PEUA"),
  person("cm2", "aom", "Cluster Manager"),
  person("tl2", "cm2", "Team Lead", "KOZA"),
  person("da3", "tl2", "Station Support Associate", "KOZA"),
  person("aom2", "nh", "Area Operations Manager"),
  person("cm3", "aom2", "Cluster Manager"),
  person("tl3", "cm3", "Team Lead", "KTUB"),
  person("loose", null, "Station Support Associate", "PEUA")
];
const ids = (view) => view.nodes.map((node) => node.id).sort();
const relation = (view, id) => view.nodes.find((node) => node.id === id)?.relation;

test("a manager sees the line above them and everyone below, nothing beside", () => {
  const view = buildTeamOrgView(people, { personId: "p-cm1", allLocations: false, locationIds: [] });
  assert.equal(view.mode, "team");
  assert.deepEqual(ids(view), ["aom", "cm1", "da1", "da2", "nh", "tl1"]);
  assert.equal(relation(view, "cm1"), "self");
  assert.equal(relation(view, "aom"), "upline");
  assert.equal(relation(view, "da1"), "team");
  assert.deepEqual(view.counts, { people: 4, uplineLevels: 2, directReports: 1, team: 3, locations: 1 });
});

test("a location login sees the people posted there and the clusters they report to", () => {
  const view = buildTeamOrgView(people, { personId: null, allLocations: false, locationIds: ["loc-PEUA"] });
  assert.equal(view.mode, "location");
  assert.deepEqual(ids(view), ["aom", "cm1", "da1", "da2", "loose", "nh", "tl1"]);
  assert.equal(relation(view, "da1"), "location");
  assert.equal(relation(view, "cm1"), "upline");
  assert.deepEqual(view.coverage, [{
    location: "PEUA", people: 4,
    leads: [{ name: "tl1", title: "Team Lead" }],
    clusterManagers: [{ name: "cm1", title: "Cluster Manager" }],
    areaManagers: [{ name: "aom", title: "Area Operations Manager" }]
  }]);
  assert.equal(view.nodes.find((node) => node.id === "da1").clusterManager, "cm1");
  assert.equal(view.nodes.find((node) => node.id === "loose").clusterManager, null);
});

test("team and location scope combine without exposing other clusters", () => {
  const view = buildTeamOrgView(people, { personId: "p-tl1", allLocations: false, locationIds: ["loc-KOZA"] });
  assert.deepEqual(ids(view), ["aom", "cm1", "cm2", "da1", "da2", "da3", "nh", "tl1", "tl2"]);
  assert.equal(relation(view, "tl2"), "location");
  assert.equal(relation(view, "cm2"), "upline");
  assert.ok(!ids(view).includes("tl3"));
});

test("all-location access sees the whole company; no scope sees nothing", () => {
  const company = buildTeamOrgView(people, { personId: "p-aom", allLocations: true, locationIds: [] });
  assert.equal(company.mode, "company");
  assert.equal(company.nodes.length, people.length);
  assert.equal(relation(company, "cm3"), "org");
  assert.equal(relation(company, "nh"), "upline");
  const none = buildTeamOrgView(people, { personId: null, allLocations: false, locationIds: [] });
  assert.equal(none.mode, "none");
  assert.deepEqual(none.nodes, []);
});

test("cycles and managers missing from the graph do not loop or leak", () => {
  const looped = [person("a", "b", "Team Lead", "PEUA"), person("b", "a", "Cluster Manager"), person("c", "gone", "Team Lead", "PEUA")];
  const view = buildTeamOrgView(looped, { personId: null, allLocations: false, locationIds: ["loc-PEUA"] });
  assert.deepEqual(ids(view), ["a", "b", "c"]);
  assert.equal(view.nodes.find((node) => node.id === "c").managerId, null);
});

test("payload carries no person or location identifiers", () => {
  const view = buildTeamOrgView(people, { personId: "p-cm1", allLocations: false, locationIds: [] });
  for (const node of view.nodes) assert.deepEqual(Object.keys(node).filter((key) => /personId|locationId|designationCode/.test(key)), []);
});

test("role families", () => {
  assert.equal(teamOrgFamily(person("x", null, "Sr. Cluster Manager")), "cluster_manager");
  assert.equal(teamOrgFamily(person("x", null, "Anything", null, { designationCode: "AOM" })), "aom");
  assert.equal(teamOrgFamily(person("x", null, "Station Manager")), "lead");
  assert.equal(teamOrgFamily(person("x", null, "Station Support Associate")), "other");
});
