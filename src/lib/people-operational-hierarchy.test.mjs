import assert from "node:assert/strict";
import test from "node:test";

import { resolveManagerChainForPersonIds, resolvePeopleOperationalHierarchy } from "./people-operational-hierarchy-core.ts";

const assignment = (id, personId, displayName, locationId, designationCode, designationName) => ({
  id,
  personId,
  displayName,
  locationId,
  designationCode,
  designationName,
  positionTitle: designationName
});

test("derives cluster manager and direct national-head fallback from People", () => {
  const result = resolvePeopleOperationalHierarchy(
    ["ERSE"],
    [
      assignment("tl", "p-tl", "AMAL", "ERSE", "TL", "Team Lead"),
      assignment("clm", "p-clm", "MUHAMMED ALI SHIHAB", "HO_KL", "CLM", "Cluster Manager"),
      assignment("nh", "p-nh", "ABDUL GAFOOR", "HO_KL", "NH", "National Head"),
      assignment("owner", "p-owner", "OWNER", "HO", "OWNER", "Owner")
    ],
    [
      { subjectAssignmentId: "tl", managerAssignmentId: "clm" },
      { subjectAssignmentId: "clm", managerAssignmentId: "nh" },
      { subjectAssignmentId: "nh", managerAssignmentId: "owner" }
    ]
  ).get("ERSE");

  assert.equal(result?.clusterManagers[0]?.name, "MUHAMMED ALI SHIHAB");
  assert.deepEqual(result?.areaOperationsManagers, []);
  assert.equal(result?.reportingAuthorities[0]?.name, "ABDUL GAFOOR");
  assert.equal(result?.reportingAuthorities[0]?.role, "National Head");
  assert.deepEqual(result?.primaryReportingChain.map((person) => person.name), ["AMAL", "MUHAMMED ALI SHIHAB", "ABDUL GAFOOR"]);
});

test("uses an AOM when the People reporting chain contains one", () => {
  const result = resolvePeopleOperationalHierarchy(
    ["GNTF"],
    [
      assignment("tl", "p-tl", "LOCAL TL", "GNTF", "TL", "Team Lead"),
      assignment("clm", "p-clm", "BHARAT", "HO_AP", "CLM", "Cluster Manager"),
      assignment("aom", "p-aom", "NAGOOR", "HO_AP", "AOM", "Area Operations Manager"),
      assignment("nh", "p-nh", "NATIONAL HEAD", "HO", "NH", "National Head")
    ],
    [
      { subjectAssignmentId: "tl", managerAssignmentId: "clm" },
      { subjectAssignmentId: "clm", managerAssignmentId: "aom" },
      { subjectAssignmentId: "aom", managerAssignmentId: "nh" }
    ]
  ).get("GNTF");

  assert.equal(result?.clusterManagers[0]?.name, "BHARAT");
  assert.equal(result?.areaOperationsManagers[0]?.name, "NAGOOR");
  assert.equal(result?.reportingAuthorities[0]?.name, "NAGOOR");
});

test("never revives a legacy manager who is absent from People", () => {
  const result = resolvePeopleOperationalHierarchy(
    ["AWEZ"],
    [
      assignment("tl", "p-tl", "SABITH", "AWEZ", "TL", "Team Lead"),
      assignment("clm", "p-clm", "MUHAMMED ALI SHIHAB", "HO_KL", "CLM", "Cluster Manager")
    ],
    [{ subjectAssignmentId: "tl", managerAssignmentId: "clm" }]
  ).get("AWEZ");

  assert.deepEqual(result?.clusterManagers.map((person) => person.name), ["MUHAMMED ALI SHIHAB"]);
  assert.ok(!result?.clusterManagers.some((person) => person.name === "Dhananjay"));
});

test("station reviews retain the unambiguous CM chain when one TL has no reporting link", () => {
  const result=resolvePeopleOperationalHierarchy(["PEUA"],[
    assignment("tl","tl","Unlinked TL","PEUA","TL","Team Lead"),
    assignment("ssa","ssa","Station SSA","PEUA","SSA","Station Support Associate"),
    assignment("cm","cm","CM","HO","CLM","Cluster Manager"),
    assignment("nh","nh","NH","HO","NH","National Head")
  ],[{subjectAssignmentId:"ssa",managerAssignmentId:"cm"},{subjectAssignmentId:"cm",managerAssignmentId:"nh"}]).get("PEUA");
  assert.deepEqual(result.managerReportingChain.map(person=>person.designationCode),["CLM","NH"]);
});

test("ops-scoped CM personal chain is available when a station has no People roots", () => {
  const chain = resolveManagerChainForPersonIds(
    ["p-cm", "p-aom", "p-nh"],
    [
      assignment("cm", "p-cm", "BHARAT", "HO", "CLM", "Cluster Manager"),
      assignment("aom", "p-aom", "NAGOOR", "HO", "AOM", "Area Operations Manager"),
      assignment("nh", "p-nh", "ABDUL", "HO", "NH", "National Head")
    ],
    [
      { subjectAssignmentId: "cm", managerAssignmentId: "aom" },
      { subjectAssignmentId: "aom", managerAssignmentId: "nh" }
    ]
  );
  assert.deepEqual(chain.map((person) => person.designationCode), ["CLM", "AOM", "NH"]);
  assert.equal(chain[0].name, "BHARAT");
});

test("multiple station CMs still produce a manager review chain from the top-ranked CM", () => {
  const result = resolvePeopleOperationalHierarchy(
    ["XAPL"],
    [
      assignment("tl1", "p-tl1", "TL One", "XAPL", "TL", "Team Lead"),
      assignment("cm1", "p-cm1", "Alpha CM", "HO", "CLM", "Cluster Manager"),
      assignment("cm2", "p-cm2", "Beta CM", "HO", "CLM", "Cluster Manager"),
      assignment("nh", "p-nh", "NH", "HO", "NH", "National Head")
    ],
    [
      { subjectAssignmentId: "tl1", managerAssignmentId: "cm1" },
      { subjectAssignmentId: "cm1", managerAssignmentId: "nh" },
      { subjectAssignmentId: "cm2", managerAssignmentId: "nh" }
    ]
  ).get("XAPL");
  assert.equal(result?.managerReportingChain[0]?.name, "Alpha CM");
  assert.deepEqual(result?.managerReportingChain.map((person) => person.designationCode), ["CLM", "NH"]);
});
