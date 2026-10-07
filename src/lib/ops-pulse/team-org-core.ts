import { peopleOperationalRoleFamily } from "../people-operational-hierarchy-core.ts";

/** One active person on their current primary People assignment. */
export type TeamOrgPerson = {
  id: string;
  personId: string;
  managerId: string | null;
  name: string;
  code: string | null;
  title: string;
  designationCode: string | null;
  locationId: string | null;
  location: string | null;
  department: string | null;
  isTopLevel: boolean;
};

export type TeamOrgRelation = "self" | "upline" | "team" | "location" | "org";
export type TeamOrgFamily = "lead" | "cluster_manager" | "aom" | "higher_authority" | "other";
export type TeamOrgMode = "company" | "team" | "location" | "none";

/** What the browser receives: no person IDs, contact details or location IDs. */
export type TeamOrgNode = {
  id: string;
  managerId: string | null;
  name: string;
  code: string | null;
  title: string;
  location: string | null;
  department: string | null;
  isTopLevel: boolean;
  relation: TeamOrgRelation;
  family: TeamOrgFamily;
  clusterManager: string | null;
};

export type TeamOrgCoveragePerson = { name: string; title: string };
export type TeamOrgCoverage = {
  location: string;
  people: number;
  leads: TeamOrgCoveragePerson[];
  clusterManagers: TeamOrgCoveragePerson[];
  areaManagers: TeamOrgCoveragePerson[];
};

export type TeamOrgViewer = { personId: string | null; allLocations: boolean; locationIds: string[] };

export type TeamOrgView = {
  mode: TeamOrgMode;
  nodes: TeamOrgNode[];
  selfIds: string[];
  coverage: TeamOrgCoverage[];
  counts: { people: number; uplineLevels: number; directReports: number; team: number; locations: number };
};

const MAX_DEPTH = 32;
const LEAD_ROLE = /(^| )(TL|ATL|STM|TEAM LEAD|TEAM LEADER|STATION MANAGER|STORE MANAGER|HUB INCHARGE)( |$)/;

export function teamOrgFamily(person: Pick<TeamOrgPerson, "id" | "personId" | "name" | "locationId" | "designationCode" | "title">): TeamOrgFamily {
  const family = peopleOperationalRoleFamily({
    id: person.id,
    personId: person.personId,
    displayName: person.name,
    locationId: person.locationId,
    designationCode: person.designationCode,
    designationName: person.title,
    positionTitle: person.title
  });
  if (family !== "other") return family;
  const role = `${person.designationCode ?? ""} ${person.title}`.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return LEAD_ROLE.test(role) ? "lead" : "other";
}

/**
 * Narrow the company reporting graph to what one Ops login may see:
 * themselves, everyone reporting up to them, everyone posted at their scoped
 * locations, and the reporting line above each of those people.
 */
export function buildTeamOrgView(people: TeamOrgPerson[], viewer: TeamOrgViewer): TeamOrgView {
  const byId = new Map(people.map((person) => [person.id, person]));
  const managerOf = (person: TeamOrgPerson) => {
    const managerId = person.managerId && person.managerId !== person.id ? person.managerId : null;
    return managerId && byId.has(managerId) ? managerId : null;
  };
  const children = new Map<string, string[]>();
  for (const person of people) {
    const managerId = managerOf(person);
    if (!managerId) continue;
    const list = children.get(managerId);
    if (list) list.push(person.id); else children.set(managerId, [person.id]);
  }
  const ancestorsOf = (id: string) => {
    const chain: string[] = [];
    const seen = new Set([id]);
    let cursor = managerOf(byId.get(id)!);
    while (cursor && !seen.has(cursor) && chain.length < MAX_DEPTH) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = managerOf(byId.get(cursor)!);
    }
    return chain;
  };

  const selfIds = viewer.personId ? people.filter((person) => person.personId === viewer.personId).map((person) => person.id) : [];
  const self = new Set(selfIds);
  const team = new Set<string>();
  const queue = [...selfIds];
  while (queue.length) {
    for (const childId of children.get(queue.pop()!) ?? []) {
      if (self.has(childId) || team.has(childId)) continue;
      team.add(childId);
      queue.push(childId);
    }
  }
  const scopedLocations = new Set(viewer.locationIds);
  const core = new Set<string>(viewer.allLocations ? byId.keys() : [...self, ...team]);
  if (!viewer.allLocations) {
    for (const person of people) if (person.locationId && scopedLocations.has(person.locationId)) core.add(person.id);
  }
  const selfUpline = new Set(selfIds.flatMap(ancestorsOf));
  const visible = new Set(core);
  for (const id of core) for (const ancestorId of ancestorsOf(id)) visible.add(ancestorId);

  const families = new Map<string, TeamOrgFamily>();
  const familyOf = (id: string) => {
    let family = families.get(id);
    if (!family) { family = teamOrgFamily(byId.get(id)!); families.set(id, family); }
    return family;
  };
  const firstInLine = (id: string, family: TeamOrgFamily, includeSelf: boolean) =>
    [...(includeSelf ? [id] : []), ...ancestorsOf(id)].find((candidateId) => familyOf(candidateId) === family) ?? null;

  const relationOf = (id: string): TeamOrgRelation => {
    if (self.has(id)) return "self";
    if (selfUpline.has(id)) return "upline";
    if (team.has(id)) return "team";
    if (viewer.allLocations) return "org";
    return core.has(id) ? "location" : "upline";
  };

  const coverageByLocation = new Map<string, { people: number; leads: Map<string, number>; clusterManagers: Map<string, number>; areaManagers: Map<string, number> }>();
  const tally = (counts: Map<string, number>, id: string | null) => { if (id) counts.set(id, (counts.get(id) ?? 0) + 1); };
  const nodes: TeamOrgNode[] = [];
  for (const person of people) {
    if (!visible.has(person.id)) continue;
    const clusterManagerId = firstInLine(person.id, "cluster_manager", false);
    nodes.push({
      id: person.id,
      managerId: managerOf(person),
      name: person.name,
      code: person.code,
      title: person.title,
      location: person.location,
      department: person.department,
      isTopLevel: person.isTopLevel,
      relation: relationOf(person.id),
      family: familyOf(person.id),
      clusterManager: clusterManagerId ? byId.get(clusterManagerId)!.name : null
    });
    if (!core.has(person.id) || !person.location) continue;
    let entry = coverageByLocation.get(person.location);
    if (!entry) {
      entry = { people: 0, leads: new Map(), clusterManagers: new Map(), areaManagers: new Map() };
      coverageByLocation.set(person.location, entry);
    }
    entry.people += 1;
    if (familyOf(person.id) === "lead") tally(entry.leads, person.id);
    tally(entry.clusterManagers, firstInLine(person.id, "cluster_manager", true));
    tally(entry.areaManagers, firstInLine(person.id, "aom", true));
  }
  nodes.sort((left, right) => left.name.localeCompare(right.name));

  const ranked = (counts: Map<string, number>): TeamOrgCoveragePerson[] => [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || byId.get(left[0])!.name.localeCompare(byId.get(right[0])!.name))
    .map(([id]) => ({ name: byId.get(id)!.name, title: byId.get(id)!.title }));
  const coverage = [...coverageByLocation.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([location, entry]) => ({
      location,
      people: entry.people,
      leads: ranked(entry.leads),
      clusterManagers: ranked(entry.clusterManagers),
      areaManagers: ranked(entry.areaManagers)
    }));

  const mode: TeamOrgMode = !nodes.length ? "none" : viewer.allLocations ? "company" : selfIds.length ? "team" : "location";
  return {
    mode,
    nodes,
    selfIds,
    coverage,
    counts: {
      people: core.size,
      uplineLevels: selfIds.length ? Math.max(...selfIds.map((id) => ancestorsOf(id).length)) : 0,
      directReports: new Set(selfIds.flatMap((id) => children.get(id) ?? [])).size,
      team: team.size,
      locations: coverage.length
    }
  };
}
