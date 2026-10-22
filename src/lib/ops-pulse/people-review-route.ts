/** Pure routing: names and titles label stages; People identities and relationships select them. */
export type ReviewPerson = {
  id: string; personId: string; name: string; designationId: string;
  code: string; role: string; locationId: string | null;
  canManage: boolean; oversight: boolean; userIds: string[]; scopeIds: string[]; allLocations: boolean;
};
export type PeopleReviewGraph = {
  people: ReviewPerson[];
  relationships: { subjectId: string; managerId: string }[];
  parentStationById?: Map<string, string>;
  /** Amazon Now / Dark Store station ids — use DS review seats instead of LM CM/AOM. */
  darkStoreStationIds?: Set<string>;
};
export type PeopleReviewStage = {
  reviewerName: string; reviewerRole: string; reviewerUserId: string;
  personId: string; assignmentId: string; designationId: string; routingSource: 'people';
};
export type PeopleReviewRoute = { chain: PeopleReviewStage[]; error: string | null };

const roleText = (p: ReviewPerson) => ` ${`${p.code} ${p.role}`.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;

/** Shared finance seats — same for LM and DS; never a performance-review stage. */
const financeRole = (p: ReviewPerson) =>
  /\b(FIN|FINANCE|FINMGR|FH|FINANCE MANAGER|FINANCE HEAD|CFO)\b/.test(roleText(p));

/** National Head is shared across LM and DS (e.g. Abdul) and stays on every review route. */
const nationalHeadRole = (p: ReviewPerson) => /\b(NH|NATIONAL HEAD)\b/.test(roleText(p));

/** Last Mile station-floor seats — never review stages. */
const lastMileFloorRole = (p: ReviewPerson) =>
  /\b(LOCATION|TL|ATL|STM|SSA|TEAM LEAD|TEAM LEADER|STATION MANAGER|STATION SUPPORT ASSOCIATE)\b/.test(roleText(p));

/** Dark Store floor seats — pickers / SSA / TL only. Store Manager and Shift Incharge review. */
const darkStoreFloorRole = (p: ReviewPerson) =>
  /\b(LOCATION|TL|ATL|SSA|TEAM LEAD|TEAM LEADER|STATION SUPPORT ASSOCIATE|PICKER)\b/.test(roleText(p))
  && !darkStoreReviewRole(p);

/** CM / AOM / NH — Last Mile operational preference (same tokens as reviewRole). */
const lastMileOperationalRole = (p: ReviewPerson) =>
  /\b(CLM|CM|CLUSTER MANAGER|CLUSTER HEAD|CLUSTER MGR)\b/.test(roleText(p))
  || /\b(AOM|AM|AREA OPERATIONS? MANAGER|AREA MANAGER)\b/.test(roleText(p))
  || nationalHeadRole(p);

/**
 * Dark Store review seats only: Shift Incharge → Store Manager → City Manager →
 * Regional Manager → National Head.
 */
export function darkStoreReviewRole(p: Pick<ReviewPerson, "code" | "role">) {
  const text = roleText(p as ReviewPerson);
  if (/\b(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)\b/.test(text)) return true;
  if (/\b(STORE MANAGER|SENIOR STORE MANAGER|SRSM)\b/.test(text)) return true;
  // SM = Store Manager; never treat STM / Station Manager as a DS review seat.
  if (/\bSM\b/.test(text) && !/\b(STM|STATION MANAGER)\b/.test(text)) return true;
  if (/\b(CITY MANAGER|CTM)\b/.test(text)) return true;
  if (/\b(RM|REGIONAL MANAGER|REGIONAL HEAD)\b/.test(text)) return true;
  if (nationalHeadRole(p as ReviewPerson)) return true;
  return false;
}

const isOperationalChain = (chain: ReviewPerson[], darkStore: boolean) =>
  chain.some((person) => darkStore ? darkStoreReviewRole(person) : lastMileOperationalRole(person));

export function resolvePeopleReviewRoute(graph: PeopleReviewGraph, stationId: string): PeopleReviewRoute {
  const byId = new Map(graph.people.map(p => [p.id, p]));
  const managers = new Map<string, Set<string>>();
  for (const edge of graph.relationships) {
    const ids = managers.get(edge.subjectId) ?? new Set<string>();
    ids.add(edge.managerId); managers.set(edge.subjectId, ids);
  }
  const darkStore = Boolean(graph.darkStoreStationIds?.has(stationId));
  const floorRole = darkStore ? darkStoreFloorRole : lastMileFloorRole;
  const eligible = (p: ReviewPerson) => {
    if (financeRole(p) || floorRole(p)) return false;
    if (darkStore) {
      // DS review seats are always stages; other managers may sit in the line but are filtered out.
      if (darkStoreReviewRole(p)) return true;
      return p.canManage && !p.oversight;
    }
    // NH is shared across businesses and remains a review stage even if Master marks them oversight.
    if (nationalHeadRole(p)) return true;
    return p.canManage && !p.oversight && !lastMileFloorRole(p);
  };
  let roots = graph.people.filter(p => p.locationId === stationId && (managers.has(p.id) || eligible(p)));
  // A sub-station with nobody posted to it (its staff sit under the mother
  // station, e.g. XAPL under GNTI) is reviewed by its mother station's route.
  const parentId = graph.parentStationById?.get(stationId);
  if (!roots.length && parentId && parentId !== stationId) {
    const parentRoute = resolvePeopleReviewRoute({ ...graph, parentStationById: undefined }, parentId);
    if (!parentRoute.error) {
      const outside = parentRoute.chain.find(stage => {
        const person = byId.get(stage.assignmentId);
        return person && !person.allLocations && !person.scopeIds.includes(stationId);
      });
      if (outside) return { chain: [], error: `${outside.reviewerName} does not have OpsPulse access to this station in People.` };
      return parentRoute;
    }
  }
  // Scope is only a seed when People has no station posting; relationships still define the entire route.
  if (!roots.length) roots = graph.people.filter(p => eligible(p) && (p.allLocations || p.scopeIds.includes(stationId)));
  const fail = (error: string): PeopleReviewRoute => ({ chain: [], error });
  if (!roots.length) {
    return fail(darkStore
      ? 'No Shift Incharge, Store Manager, City Manager, Regional Manager or National Head is mapped to this store in People.'
      : 'No reporting manager is mapped to this station in People.');
  }
  const chains: ReviewPerson[][] = [];
  for (const root of roots) {
    const chain: ReviewPerson[] = [], seen = new Set<string>(), seenPeople = new Set<string>();
    let current: ReviewPerson | undefined = root;
    while (current) {
      if (seen.has(current.id) || seenPeople.has(current.personId)) return fail('People reporting relationships contain a cycle or duplicate primary assignment.');
      seen.add(current.id); seenPeople.add(current.personId);
      // Full-tier oversight (e.g. Program Manager / finance) ends the route.
      // National Head is shared for LM + DS and stays on the route for both businesses.
      if (current.oversight && !nationalHeadRole(current) && !(darkStore && darkStoreReviewRole(current))) break;
      if (seen.size > 1 && !current.canManage && !floorRole(current) && !financeRole(current) && !(darkStore && darkStoreReviewRole(current)) && !nationalHeadRole(current)) {
        return fail(`${current.name} is not enabled as a reporting manager in People.`);
      }
      if (eligible(current)) chain.push(current);
      const next = [...(managers.get(current.id) ?? [])];
      if (next.length > 1) return fail(`Multiple active reporting managers are mapped for ${current.name} in People.`);
      if (!next.length) break;
      current = byId.get(next[0]);
      if (!current) return fail('A reporting manager has an inactive, expired or missing People assignment.');
      if (seen.size > 64) return fail('People reporting hierarchy exceeds 64 levels.');
    }
    if (chain.length) chains.push(chain);
  }
  if (!chains.length) {
    return fail(darkStore
      ? 'No Shift Incharge, Store Manager, City Manager, Regional Manager or National Head is mapped in People.'
      : 'No eligible review manager is mapped in People.');
  }
  // Dark Store: compare only SI / Store / City / RM / NH seats so finance or LM
  // people posted at the store cannot invent a second conflicting route.
  const operationalChains = darkStore
    ? chains.map((chain) => chain.filter(darkStoreReviewRole)).filter((chain) => chain.length)
    : chains.some((chain) => isOperationalChain(chain, false))
      ? chains.filter((chain) => isOperationalChain(chain, false))
      : chains;
  if (!operationalChains.length) {
    return fail(darkStore
      ? 'No Shift Incharge, Store Manager, City Manager, Regional Manager or National Head is mapped for this store in People.'
      : 'No eligible review manager is mapped in People.');
  }
  operationalChains.sort((a, b) => b.length - a.length);
  const selected = operationalChains[0];
  // Every other operational root must converge on the same route; never choose alphabetically.
  if (operationalChains.some(chain => chain.some((p, i) => p.id !== selected[selected.length - chain.length + i]?.id))) {
    return fail('People has conflicting reporting routes for this station. Resolve the primary manager mapping.');
  }
  const stages = selected;
  if (!stages.length) {
    return fail(darkStore
      ? 'No Shift Incharge, Store Manager, City Manager, Regional Manager or National Head is mapped for this store in People.'
      : 'No eligible review manager is mapped in People.');
  }
  const chain: PeopleReviewStage[] = [];
  for (const p of stages) {
    if (p.userIds.length !== 1) return fail(`${p.name} needs exactly one active OpsPulse account linked in People.`);
    if (!p.allLocations && !p.scopeIds.includes(stationId)) return fail(`${p.name} does not have OpsPulse access to this station in People.`);
    chain.push({ reviewerName: p.name, reviewerRole: p.role, reviewerUserId: p.userIds[0], personId: p.personId,
      assignmentId: p.id, designationId: p.designationId, routingSource: 'people' });
  }
  return { chain, error: null };
}

/** Pure Amazon Now / Dark Store detection for routing (no cookies). */
export function isDarkStoreStationRow(row: {
  station_code?: string | null;
  station_name?: string | null;
  providers?: { code?: string | null; name?: string | null } | { code?: string | null; name?: string | null }[] | null;
  location_models?: { code?: string | null; name?: string | null } | { code?: string | null; name?: string | null }[] | null;
}) {
  const first = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null;
  const provider = first(row.providers);
  const model = first(row.location_models);
  const modelName = String(model?.name ?? model?.code ?? "").toUpperCase();
  const providerName = String(provider?.name ?? provider?.code ?? "").toUpperCase();
  return modelName === "NOW" || `${providerName} ${modelName}`.includes("AMAZON NOW");
}
