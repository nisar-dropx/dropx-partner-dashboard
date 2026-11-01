import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRosterManagerChain } from "./roster-approval-route.ts";

const person = (id, code, extra = {}) => ({
  id, personId: id, name: id, designationId: code, code, role: code,
  locationId: null, canManage: true, oversight: false, userIds: [id],
  scopeIds: ["station"], allLocations: false, ...extra
});

const lastMileGraph = () => ({
  people: [
    person("tl", "TL", { role: "Team Lead", locationId: "station" }),
    person("cluster", "CLM", { role: "Cluster Manager" }),
    person("area", "AOM", { role: "Area Operations Manager" }),
    person("head", "HLM", { role: "Head Operations- Last Mile" })
  ],
  relationships: [
    { subjectId: "tl", managerId: "cluster" },
    { subjectId: "cluster", managerId: "area" },
    { subjectId: "area", managerId: "head" }
  ]
});

const darkStoreGraph = () => ({
  darkStoreStationIds: new Set(["store"]),
  people: [
    person("si", "SIC", { role: "Shift Incharge", locationId: "store", scopeIds: ["store"] }),
    person("sm", "SM", { role: "Store Manager", scopeIds: ["store"] }),
    person("city", "CTM", { role: "City Manager", scopeIds: ["store"] }),
    person("rm", "RM", { role: "Regional Manager", scopeIds: ["store"] })
  ],
  relationships: [
    { subjectId: "si", managerId: "sm" },
    { subjectId: "sm", managerId: "city" },
    { subjectId: "city", managerId: "rm" }
  ]
});

test("Last Mile roster starts at Cluster Manager, then next reporting manager", () => {
  const chain = resolveRosterManagerChain(lastMileGraph(), "station", 2).chain.map((stage) => stage.personId);
  assert.deepEqual(chain, ["cluster", "area"]);
});

test("Dark Store roster starts at City Manager and skips Store Manager when City Manager exists", () => {
  const chain = resolveRosterManagerChain(darkStoreGraph(), "store", 2).chain.map((stage) => stage.personId);
  assert.deepEqual(chain, ["city", "rm"]);
});

test("Dark Store falls back to Store Manager only when no City Manager is mapped", () => {
  const graph = darkStoreGraph();
  graph.people = graph.people.filter((row) => row.id !== "city");
  graph.relationships = [
    { subjectId: "si", managerId: "sm" },
    { subjectId: "sm", managerId: "rm" }
  ];
  const chain = resolveRosterManagerChain(graph, "store", 2).chain.map((stage) => stage.personId);
  assert.deepEqual(chain, ["sm", "rm"]);
});

test("missing Cluster Manager login skips to the next reporting manager", () => {
  const graph = lastMileGraph();
  graph.people[1].userIds = [];
  const chain = resolveRosterManagerChain(graph, "station", 2).chain.map((stage) => stage.personId);
  assert.deepEqual(chain, ["area", "head"]);
});

test("missing City Manager login still prefers the City→RM line once City is unusable", () => {
  const graph = darkStoreGraph();
  graph.people.find((row) => row.id === "city").userIds = [];
  const chain = resolveRosterManagerChain(graph, "store", 2).chain.map((stage) => stage.personId);
  // Soft skip City; RM remains. Store Manager stays out because City is mapped on the line.
  assert.deepEqual(chain, ["rm"]);
});

test("out-of-scope managers are skipped without inventing Store Manager ahead of City", () => {
  const graph = darkStoreGraph();
  graph.people.find((row) => row.id === "city").scopeIds = ["other"];
  const chain = resolveRosterManagerChain(graph, "store", 2).chain.map((stage) => stage.personId);
  assert.deepEqual(chain, ["rm"]);
});
