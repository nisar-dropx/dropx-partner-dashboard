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

/** Dark Store floor seats — pickers / SSA / TL only (not City / Regional review seats). */
const darkStoreFloorRole = (p: ReviewPerson) =>
  /\b(LOCATION|TL|ATL|SSA|TEAM LEAD|TEAM LEADER|STATION SUPPORT ASSOCIATE|PICKER)\b/.test(roleText(p))
  && !darkStoreReviewRole(p);

/** CM / AOM / NH — Last Mile operational preference (same tokens as reviewRole). */
const lastMileOperationalRole = (p: ReviewPerson) =>
  /\b(CLM|CM|CLUSTER MANAGER|CLUSTER HEAD|CLUSTER MGR)\b/.test(roleText(p))
  || /\b(AOM|AM|AREA OPERATIONS? MANAGER|AREA MANAGER)\b/.test(roleText(p))
  || nationalHeadRole(p);

/**
 * Dark Store review seats: City Manager → Regional Manager → National Head.
 * Shift Incharge / Store Manager run the store; FSD / Owner still cover via Proxy / Skip.
 */
export function darkStoreReviewRole(p: Pick<ReviewPerson, "code" | "role">) {
  const text = roleText(p as ReviewPerson);
  if (/\b(CITY MANAGER|CITY HEAD|CTM)\b/.test(text)) return true;
  if (/\b(RM|REGIONAL MANAGER|REGIONAL HEAD)\b/.test(text)) return true;
  if (/\b(NH|NATIONAL HEAD)\b/.test(text)) return true;
  return false;
}

/** Ordered DS review tiers — parallel City Managers may share one Regional → NH line. */
export function darkStoreReviewTier(p: Pick<ReviewPerson, "code" | "role">): "city" | "rm" | "nh" | null {
  const text = roleText(p as ReviewPerson);
  if (/\b(CITY MANAGER|CITY HEAD|CTM)\b/.test(text)) return "city";
  if (/\b(RM|REGIONAL MANAGER|REGIONAL HEAD)\b/.test(text)) return "rm";
  if (/\b(NH|NATIONAL HEAD)\b/.test(text)) return "nh";
  return null;
}

const isOperationalChain = (chain: ReviewPerson[], darkStore: boolean) =>
  chain.some((person) => darkStore ? darkStoreReviewRole(person) : lastMileOperationalRole(person));

/** City → RM → NH (from first City/RM) — NH-only suffixes must not glue divergent City lines together. */
function darkStoreUpwardKey(chain: ReviewPerson[]) {
  const idx = chain.findIndex((person) => {
    const tier = darkStoreReviewTier(person);
    return tier === "city" || tier === "rm";
  });
  return idx >= 0 ? chain.slice(idx) : [];
}

function samePeopleSuffix(left: ReviewPerson[], right: ReviewPerson[]) {
  if (left.length > right.length) return false;
  return left.every((person, index) => person.id === right[right.length - left.length + index]?.id);
}

/**
 * True when `chain` is the same route as `selected`, a Dark Store peer root
 * that shares managers above, or another DS line that shares the same City→RM→NH.
 */
function operationalChainConverges(chain: ReviewPerson[], selected: ReviewPerson[], darkStore: boolean) {
  if (chain.every((person, index) => person.id === selected[selected.length - chain.length + index]?.id)) {
    return true;
  }
  if (!darkStore) return false;
  // Same-tier peer (two Shift Incharges) with identical managers above.
  if (chain.length === selected.length && chain.length >= 2) {
    const rootTier = darkStoreReviewTier(chain[0]);
    if (rootTier && rootTier === darkStoreReviewTier(selected[0])
      && chain.slice(1).every((person, index) => person.id === selected[index + 1]?.id)) {
      return true;
    }
  }
  // Floor / other lines that share the same City → RM are one store route, not a conflict.
  const selectedUp = darkStoreUpwardKey(selected);
  const chainUp = darkStoreUpwardKey(chain);
  if (!selectedUp.length || !chainUp.length) return false;
  return samePeopleSuffix(chainUp, selectedUp) || samePeopleSuffix(selectedUp, chainUp);
}

function conflictingRouteDetail(chains: ReviewPerson[][], selected: ReviewPerson[], darkStore: boolean) {
  const diverging = chains.find((chain) => !operationalChainConverges(chain, selected, darkStore));
  if (!diverging?.length) return "";
  const label = (chain: ReviewPerson[]) => chain.map((person) => `${person.role} (${person.name})`).join(" → ");
  return ` Compare: ${label(selected.slice(0, 3))}${selected.length > 3 ? "…" : ""} vs ${label(diverging.slice(0, 3))}${diverging.length > 3 ? "…" : ""}.`;
}

export function resolvePeopleReviewRoute(
  graph: PeopleReviewGraph,
  stationId: string,
  options?: { darkStore?: boolean }
): PeopleReviewRoute {
  const byId = new Map(graph.people.map(p => [p.id, p]));
  const managers = new Map<string, Set<string>>();
  for (const edge of graph.relationships) {
    const ids = managers.get(edge.subjectId) ?? new Set<string>();
    ids.add(edge.managerId); managers.set(edge.subjectId, ids);
  }
  const darkStore = Boolean(options?.darkStore || graph.darkStoreStationIds?.has(stationId));
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
    const parentRoute = resolvePeopleReviewRoute({ ...graph, parentStationById: undefined }, parentId, options);
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
      ? 'No City Manager or Regional Manager is mapped to this store in People.'
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
      ? 'No City Manager or Regional Manager is mapped in People.'
      : 'No eligible review manager is mapped in People.');
  }
  // Dark Store: compare City → RM → NH so store-floor / finance cannot invent a conflict.
  // Require at least City or Regional — National Head alone is oversight, not a store route.
  const operationalChains = darkStore
    ? chains
      .map((chain) => chain.filter(darkStoreReviewRole))
      .filter((chain) => chain.some((person) => {
        const tier = darkStoreReviewTier(person);
        return tier === "city" || tier === "rm";
      }))
    : chains.some((chain) => isOperationalChain(chain, false))
      ? chains.filter((chain) => isOperationalChain(chain, false))
      : chains;
  if (!operationalChains.length) {
    return fail(darkStore
      ? 'No City Manager or Regional Manager is mapped for this store in People.'
      : 'No eligible review manager is mapped in People.');
  }
  // Prefer the longest route; among equal roots pick a stable name/id so peer SIs do not flip daily.
  operationalChains.sort((a, b) =>
    b.length - a.length
    || a[0].name.localeCompare(b[0].name)
    || a[0].id.localeCompare(b[0].id)
  );
  const selected = operationalChains[0];
  // Every other operational root must converge on the same route (suffix, peer root, or shared City→RM→NH).
  if (operationalChains.some((chain) => !operationalChainConverges(chain, selected, darkStore))) {
    return fail(`People has conflicting reporting routes for this station. Resolve the primary manager mapping.${conflictingRouteDetail(operationalChains, selected, darkStore)}`);
  }
  const stages = selected;
  if (!stages.length) {
    return fail(darkStore
      ? 'No City Manager or Regional Manager is mapped for this store in People.'
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
  const modelName = String(model?.name ?? model?.code ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const providerName = String(provider?.name ?? provider?.code ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const blended = `${providerName} ${modelName}`;
  return modelName === "NOW"
    || modelName === "AMAZON NOW"
    || modelName.includes("AMAZON NOW")
    || blended.includes("AMAZON NOW")
    || (providerName.includes("AMAZON") && modelName === "NOW");
}
