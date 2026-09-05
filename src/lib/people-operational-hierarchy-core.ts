export type PeopleHierarchyAssignment = {
  id: string;
  personId: string;
  displayName: string;
  locationId: string | null;
  designationCode: string | null;
  designationName: string | null;
  positionTitle: string | null;
};

export type PeopleHierarchyRelationship = {
  subjectAssignmentId: string;
  managerAssignmentId: string;
};

export type OperationalHierarchyPerson = {
  assignmentId: string;
  personId: string;
  name: string;
  role: string;
  designationCode: string | null;
  supportCount: number;
  minDepth: number;
};

export type LocationOperationalHierarchy = {
  stationLeads?: { name: string; role: string }[];
  clusterManagers: OperationalHierarchyPerson[];
  areaOperationsManagers: OperationalHierarchyPerson[];
  reportingAuthorities: OperationalHierarchyPerson[];
  primaryReportingChain: OperationalHierarchyPerson[];
  managerReportingChain: OperationalHierarchyPerson[];
  hasClusterManagerConflict: boolean;
};

type RoleFamily = "cluster_manager" | "aom" | "higher_authority" | "other";

type CandidateStats = {
  assignment: PeopleHierarchyAssignment;
  rootIds: Set<string>;
  minDepth: number;
};

function normalizedRole(assignment: PeopleHierarchyAssignment) {
  return [assignment.designationCode, assignment.designationName, assignment.positionTitle]
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function hasRoleToken(role: string, token: string) {
  return (` ${role} `).includes(` ${token} `);
}

export function peopleOperationalRoleFamily(assignment: PeopleHierarchyAssignment): RoleFamily {
  const role = normalizedRole(assignment);
  const code = String(assignment.designationCode ?? "").trim().toUpperCase();
  if (
    code === "AOM" ||
    hasRoleToken(role, "AREA OPERATIONS MANAGER") ||
    hasRoleToken(role, "AREA OPERATION MANAGER")
  ) return "aom";
  if (
    code === "CLM" ||
    code === "CM" ||
    hasRoleToken(role, "CLUSTER MANAGER") ||
    hasRoleToken(role, "CLUSTER HEAD")
  ) return "cluster_manager";
  if (
    ["RM", "RH", "ZH", "BH", "NH", "OWNER", "MANAGING_PARTNER"].includes(code) ||
    hasRoleToken(role, "REGIONAL MANAGER") ||
    hasRoleToken(role, "REGIONAL HEAD") ||
    hasRoleToken(role, "ZONAL HEAD") ||
    hasRoleToken(role, "BUSINESS HEAD") ||
    hasRoleToken(role, "NATIONAL HEAD") ||
    hasRoleToken(role, "MANAGING PARTNER") ||
    hasRoleToken(role, "OWNER")
  ) return "higher_authority";
  return "other";
}

function roleLabel(assignment: PeopleHierarchyAssignment) {
  return String(assignment.designationName || assignment.positionTitle || assignment.designationCode || "Reporting authority").trim();
}

function operationalStartPriority(assignment: PeopleHierarchyAssignment) {
  const role = normalizedRole(assignment);
  const code = String(assignment.designationCode ?? "").trim().toUpperCase();
  if (code === "TL" || hasRoleToken(role, "TEAM LEAD")) return 0;
  if (code === "STM" || hasRoleToken(role, "STATION MANAGER") || hasRoleToken(role, "HUB INCHARGE")) return 1;
  if (code === "SSA" || hasRoleToken(role, "STATION SUPPORT ASSOCIATE")) return 2;
  return 10;
}

function isTerminalAuthority(assignment: PeopleHierarchyAssignment) {
  const role = normalizedRole(assignment);
  const code = String(assignment.designationCode ?? "").trim().toUpperCase();
  return (
    ["NH", "OWNER", "MANAGING_PARTNER"].includes(code) ||
    hasRoleToken(role, "NATIONAL HEAD") ||
    hasRoleToken(role, "MANAGING PARTNER") ||
    hasRoleToken(role, "OWNER")
  );
}

function reportingChainFor(
  root: PeopleHierarchyAssignment,
  assignmentById: Map<string, PeopleHierarchyAssignment>,
  managerBySubject: Map<string, string>
) {
  const chain: OperationalHierarchyPerson[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = root.id;
  let depth = 0;
  while (currentId && depth <= 16 && !seen.has(currentId)) {
    seen.add(currentId);
    const current = assignmentById.get(currentId);
    if (!current) break;
    chain.push({
      assignmentId: current.id,
      personId: current.personId,
      name: current.displayName,
      role: roleLabel(current),
      designationCode: current.designationCode,
      supportCount: 1,
      minDepth: depth
    });
    if (isTerminalAuthority(current)) break;
    currentId = managerBySubject.get(currentId);
    depth += 1;
  }
  return chain;
}

function addCandidate(
  candidates: Map<string, CandidateStats>,
  assignment: PeopleHierarchyAssignment,
  rootId: string,
  depth: number
) {
  const current = candidates.get(assignment.id);
  if (current) {
    current.rootIds.add(rootId);
    current.minDepth = Math.min(current.minDepth, depth);
    return;
  }
  candidates.set(assignment.id, { assignment, rootIds: new Set([rootId]), minDepth: depth });
}

function rankedPeople(candidates: Map<string, CandidateStats>) {
  return [...candidates.values()]
    .map(({ assignment, rootIds, minDepth }) => ({
      assignmentId: assignment.id,
      personId: assignment.personId,
      name: assignment.displayName,
      role: roleLabel(assignment),
      designationCode: assignment.designationCode,
      supportCount: rootIds.size,
      minDepth
    }))
    .sort((left, right) => (
      right.supportCount - left.supportCount ||
      left.minDepth - right.minDepth ||
      left.name.localeCompare(right.name)
    ));
}

function firstAuthorityAbove(
  assignmentId: string,
  assignmentById: Map<string, PeopleHierarchyAssignment>,
  managerBySubject: Map<string, string>
) {
  const seen = new Set<string>([assignmentId]);
  let currentId = managerBySubject.get(assignmentId);
  let depth = 1;
  while (currentId && depth <= 16 && !seen.has(currentId)) {
    seen.add(currentId);
    const current = assignmentById.get(currentId);
    if (!current) return null;
    const family = peopleOperationalRoleFamily(current);
    if (family === "aom" || family === "higher_authority") return { assignment: current, depth };
    currentId = managerBySubject.get(currentId);
    depth += 1;
  }
  return null;
}

export function resolvePeopleOperationalHierarchy(
  locationIds: string[],
  assignments: PeopleHierarchyAssignment[],
  relationships: PeopleHierarchyRelationship[]
) {
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const managerBySubject = new Map<string, string>();
  relationships.forEach((relationship) => {
    if (!managerBySubject.has(relationship.subjectAssignmentId)) {
      managerBySubject.set(relationship.subjectAssignmentId, relationship.managerAssignmentId);
    }
  });
  const rootsByLocation = new Map<string, PeopleHierarchyAssignment[]>();
  assignments.forEach((assignment) => {
    if (!assignment.locationId) return;
    const current = rootsByLocation.get(assignment.locationId) ?? [];
    current.push(assignment);
    rootsByLocation.set(assignment.locationId, current);
  });

  return new Map(locationIds.map((locationId) => {
    const clusterCandidates = new Map<string, CandidateStats>();
    const aomCandidates = new Map<string, CandidateStats>();
    const authorityCandidates = new Map<string, CandidateStats>();
    const roots = rootsByLocation.get(locationId) ?? [];

    roots.forEach((root) => {
      const seen = new Set<string>();
      let currentId: string | undefined = root.id;
      let depth = 0;
      while (currentId && depth <= 16 && !seen.has(currentId)) {
        seen.add(currentId);
        const current = assignmentById.get(currentId);
        if (!current) break;
        const family = peopleOperationalRoleFamily(current);
        if (family === "cluster_manager") addCandidate(clusterCandidates, current, root.id, depth);
        if (family === "aom") addCandidate(aomCandidates, current, root.id, depth);
        currentId = managerBySubject.get(currentId);
        depth += 1;
      }
    });

    const clusterManagers = rankedPeople(clusterCandidates);
    const areaOperationsManagers = rankedPeople(aomCandidates);
    if (clusterManagers.length) {
      clusterManagers.forEach((clusterManager) => {
        const authority = firstAuthorityAbove(clusterManager.assignmentId, assignmentById, managerBySubject);
        if (authority) addCandidate(authorityCandidates, authority.assignment, clusterManager.assignmentId, authority.depth);
      });
    } else {
      roots.forEach((root) => {
        const authority = firstAuthorityAbove(root.id, assignmentById, managerBySubject);
        if (authority) addCandidate(authorityCandidates, authority.assignment, root.id, authority.depth);
      });
    }

    const reportingAuthorities = rankedPeople(authorityCandidates);
    const primaryRoot = [...roots]
      .filter((root) => operationalStartPriority(root) < 10)
      .sort((left, right) => (
        operationalStartPriority(left) - operationalStartPriority(right) ||
        reportingChainFor(right, assignmentById, managerBySubject).length - reportingChainFor(left, assignmentById, managerBySubject).length ||
        left.displayName.localeCompare(right.displayName)
      ))[0];
    // Station-level reviews belong to the station's canonical manager, not whichever
    // TL sorts first. An incomplete TL link must not hide an unambiguous People CM.
    const managerRoot = clusterManagers.length === 1
      ? assignmentById.get(clusterManagers[0].assignmentId)
      : !clusterManagers.length && areaOperationsManagers.length === 1
        ? assignmentById.get(areaOperationsManagers[0].assignmentId)
        : undefined;
    return [locationId, {
      stationLeads: roots.filter(root => /(^| )(TL|ATL|STM|TEAM LEAD|TEAM LEADER|STATION MANAGER)( |$)/.test(normalizedRole(root)))
        .map(root => ({name: root.displayName, role: root.designationName || root.positionTitle || "Station lead"})),
      clusterManagers,
      areaOperationsManagers,
      reportingAuthorities,
      primaryReportingChain: primaryRoot ? reportingChainFor(primaryRoot, assignmentById, managerBySubject) : [],
      managerReportingChain: managerRoot ? reportingChainFor(managerRoot, assignmentById, managerBySubject) : [],
      hasClusterManagerConflict: clusterManagers.length > 1 && clusterManagers[0].supportCount === clusterManagers[1].supportCount
    } satisfies LocationOperationalHierarchy] as const;
  }));
}
