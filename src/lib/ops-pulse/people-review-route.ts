/** Pure routing: names and titles label stages; People identities and relationships select them. */
export type ReviewPerson = {
  id: string; personId: string; name: string; designationId: string;
  code: string; role: string; locationId: string | null;
  canManage: boolean; oversight: boolean; userIds: string[]; scopeIds: string[]; allLocations: boolean;
};
export type PeopleReviewGraph = { people: ReviewPerson[]; relationships: { subjectId: string; managerId: string }[]; parentStationById?: Map<string, string> };
export type PeopleReviewStage = {
  reviewerName: string; reviewerRole: string; reviewerUserId: string;
  personId: string; assignmentId: string; designationId: string; routingSource: 'people';
};
export type PeopleReviewRoute = { chain: PeopleReviewStage[]; error: string | null };
const stationRole = (p: ReviewPerson) => /\b(LOCATION|TL|ATL|STM|SSA|TEAM LEAD|TEAM LEADER|STATION MANAGER|STATION SUPPORT ASSOCIATE)\b/.test(`${p.code} ${p.role}`.toUpperCase().replace(/[^A-Z0-9]+/g, ' '));

export function resolvePeopleReviewRoute(graph: PeopleReviewGraph, stationId: string): PeopleReviewRoute {
  const byId = new Map(graph.people.map(p => [p.id, p]));
  const managers = new Map<string, Set<string>>();
  for (const edge of graph.relationships) {
    const ids = managers.get(edge.subjectId) ?? new Set<string>();
    ids.add(edge.managerId); managers.set(edge.subjectId, ids);
  }
  const eligible = (p: ReviewPerson) => p.canManage && !p.oversight && !stationRole(p);
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
  if (!roots.length) return fail('No reporting manager is mapped to this station in People.');
  const chains: ReviewPerson[][] = [];
  for (const root of roots) {
    const chain: ReviewPerson[] = [], seen = new Set<string>(), seenPeople = new Set<string>();
    let current: ReviewPerson | undefined = root;
    while (current) {
      if (seen.has(current.id) || seenPeople.has(current.personId)) return fail('People reporting relationships contain a cycle or duplicate primary assignment.');
      seen.add(current.id); seenPeople.add(current.personId);
      if (current.oversight) break;
      if (seen.size > 1 && !current.canManage && !stationRole(current)) return fail(`${current.name} is not enabled as a reporting manager in People.`);
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
  if (!chains.length) return fail('No eligible review manager is mapped in People.');
  chains.sort((a, b) => b.length - a.length);
  const selected = chains[0];
  // Every other root must converge on the same route; never choose a conflicting manager alphabetically.
  if (chains.some(chain => chain.some((p, i) => p.id !== selected[selected.length - chain.length + i]?.id))) {
    return fail('People has conflicting reporting routes for this station. Resolve the primary manager mapping.');
  }
  const chain: PeopleReviewStage[] = [];
  for (const p of selected) {
    if (p.userIds.length !== 1) return fail(`${p.name} needs exactly one active OpsPulse account linked in People.`);
    if (!p.allLocations && !p.scopeIds.includes(stationId)) return fail(`${p.name} does not have OpsPulse access to this station in People.`);
    chain.push({ reviewerName: p.name, reviewerRole: p.role, reviewerUserId: p.userIds[0], personId: p.personId,
      assignmentId: p.id, designationId: p.designationId, routingSource: 'people' });
  }
  return { chain, error: null };
}
