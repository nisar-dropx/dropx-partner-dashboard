/**
 * Weekly roster manager stages follow the People operational line used by
 * performance reviews — not the station-floor Store/Station Manager seat.
 *
 * Last Mile: Cluster Manager → next reporting manager(s) → HR
 * Dark Store: City Manager → next reporting manager(s) → HR
 *   If no City Manager is mapped, Store Manager may start the chain.
 * Missing / unlinked / out-of-scope people are skipped; the walk continues.
 */
import {
  darkStoreReviewRole,
  darkStoreReviewTier,
  resolvePeopleReviewRoute,
  type PeopleReviewGraph,
  type ReviewPerson
} from "./people-review-route.ts";

export type RosterManagerStage = {
  userId: string;
  name: string;
  role: string;
  personId: string;
  assignmentId: string;
  designationId: string;
};

export type RosterManagerChain = {
  chain: RosterManagerStage[];
  error: string | null;
  darkStore: boolean;
};

const roleText = (person: ReviewPerson) =>
  ` ${`${person.code} ${person.role}`.toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;

function isStoreManagerSeat(person: ReviewPerson) {
  const text = roleText(person);
  if (darkStoreReviewRole(person)) return false;
  // Store / Shift Incharge run the floor — never a roster approval stage.
  if (/\b(STORE INCHARGE|STORE IN CHARGE|SHIFT INCHARGE|SHIFT IN CHARGE|SIC)\b/.test(text)) return false;
  return /\b(SRSM|SSM|SENIOR STORE MANAGER|SR STORE MANAGER)\b/.test(text)
    || /\bSTORE MANAGER\b/.test(text)
    || /\bSM\b/.test(text);
}

function isUsableApprover(person: ReviewPerson, stationId: string) {
  if (person.userIds.length !== 1) return false;
  if (!person.allLocations && !person.scopeIds.includes(stationId)) return false;
  return true;
}

function toStage(person: ReviewPerson): RosterManagerStage {
  return {
    userId: person.userIds[0],
    name: person.name,
    role: person.role,
    personId: person.personId,
    assignmentId: person.id,
    designationId: person.designationId
  };
}

function softStagesFromPeople(people: ReviewPerson[], stationId: string, requiredLevels: number) {
  const stages: RosterManagerStage[] = [];
  for (const person of people) {
    if (!isUsableApprover(person, stationId)) continue;
    if (stages.some((stage) => stage.userId === person.userIds[0] || stage.personId === person.personId)) continue;
    stages.push(toStage(person));
    if (stages.length >= requiredLevels) break;
  }
  return stages;
}

/**
 * Discover the intended People route even when some seats lack a login or
 * station scope — those seats are soft-skipped when building stages.
 */
function discoverRoutePeople(graph: PeopleReviewGraph, stationId: string, darkStore: boolean) {
  const patched: PeopleReviewGraph = {
    ...graph,
    people: graph.people.map((person) => ({
      ...person,
      userIds: person.userIds.length === 1 ? person.userIds : [`__discover__${person.id}`],
      allLocations: true,
      scopeIds: person.scopeIds.includes(stationId) ? person.scopeIds : [...person.scopeIds, stationId]
    }))
  };
  const review = resolvePeopleReviewRoute(patched, stationId, { darkStore });
  if (review.error || !review.chain.length) return null;
  const byId = new Map(graph.people.map((person) => [person.id, person]));
  return review.chain
    .map((stage) => byId.get(stage.assignmentId))
    .filter((person): person is ReviewPerson => Boolean(person));
}

function walkReportingPeople(graph: PeopleReviewGraph, root: ReviewPerson, darkStore: boolean) {
  const byId = new Map(graph.people.map((person) => [person.id, person]));
  const managers = new Map<string, string[]>();
  for (const edge of graph.relationships) {
    managers.set(edge.subjectId, [...(managers.get(edge.subjectId) ?? []), edge.managerId]);
  }
  const chain: ReviewPerson[] = [];
  const seen = new Set<string>();
  let current: ReviewPerson | undefined = root;
  while (current && !seen.has(current.id) && chain.length < 16) {
    seen.add(current.id);
    chain.push(current);
    if (darkStore && darkStoreReviewTier(current) === "rm") break;
    const nextIds = managers.get(current.id) ?? [];
    if (nextIds.length !== 1) break;
    current = byId.get(nextIds[0]);
  }
  return chain;
}

function darkStoreFallbackPeople(graph: PeopleReviewGraph, stationId: string) {
  const storeManagers = graph.people
    .filter((person) => isStoreManagerSeat(person)
      && (person.locationId === stationId || (person.managedScopeIds ?? person.scopeIds).includes(stationId)))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  if (storeManagers.length) {
    for (const manager of storeManagers) {
      const walk = walkReportingPeople(graph, manager, true);
      const cityIndex = walk.findIndex((person) => darkStoreReviewTier(person) === "city");
      if (cityIndex >= 0) return walk.slice(cityIndex);
    }
    return walkReportingPeople(graph, storeManagers[0], true);
  }

  // No Store/City Manager — start at the first City/RM seat on any posted line.
  const locals = graph.people
    .filter((person) => person.locationId === stationId || (person.managedScopeIds ?? person.scopeIds).includes(stationId))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  for (const local of locals) {
    const walk = walkReportingPeople(graph, local, true);
    const start = walk.findIndex((person) => darkStoreReviewRole(person));
    if (start >= 0) return walk.slice(start);
  }
  return [] as ReviewPerson[];
}

function preferOperationalPeople(people: ReviewPerson[], darkStore: boolean) {
  if (!darkStore) return people;
  if (people.some((person) => darkStoreReviewTier(person) === "city")) {
    return people.filter((person) => !isStoreManagerSeat(person));
  }
  return people;
}

/**
 * Resolve roster manager seats for a station from the People graph.
 * HR is appended by the caller when company policy requires it.
 */
export function resolveRosterManagerChain(
  graph: PeopleReviewGraph,
  stationId: string,
  requiredLevels: number
): RosterManagerChain {
  const levels = Math.max(1, Math.min(Number(requiredLevels) || 2, 4));
  const darkStore = Boolean(graph.darkStoreStationIds?.has(stationId));

  if (darkStore) {
    const discovered = discoverRoutePeople(graph, stationId, true) ?? [];
    const hasCity = discovered.some((person) => darkStoreReviewTier(person) === "city");
    // City Manager present → never start at Store Manager.
    // No City Manager → Store Manager → next reporting (RM/NH).
    const people = hasCity
      ? preferOperationalPeople(discovered, true)
      : darkStoreFallbackPeople(graph, stationId);
    const chain = softStagesFromPeople(people, stationId, levels);
    if (chain.length) return { chain, error: null, darkStore };
    return {
      chain: [],
      error: "No City Manager or Store Manager with an active OpsPulse login is mapped for this store in People.",
      darkStore
    };
  }

  const discovered = discoverRoutePeople(graph, stationId, false);
  if (discovered?.length) {
    const chain = softStagesFromPeople(discovered, stationId, levels);
    if (chain.length) return { chain, error: null, darkStore };
  }

  const review = resolvePeopleReviewRoute(graph, stationId, { darkStore });
  return {
    chain: [],
    error: review.error
      ?? "No Cluster Manager (or next reporting manager) with an active OpsPulse login is mapped for this station in People.",
    darkStore
  };
}
