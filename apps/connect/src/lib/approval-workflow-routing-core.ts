export type ApprovalRouteCandidate = {
  id: string;
  workflow_code: string | null;
  location_id: string | null;
  requester_person_id?: string | null;
  priority: number;
};

function routeSpecificity(route: ApprovalRouteCandidate, workflowCode: string, locationId: string | null, requesterPersonId: string | null) {
  const workflowSpecific = route.workflow_code === workflowCode;
  const locationSpecific = Boolean(locationId && route.location_id === locationId);
  const personSpecific = Boolean(requesterPersonId && route.requester_person_id === requesterPersonId);
  return Number(personSpecific) * 4 + Number(workflowSpecific) * 2 + Number(locationSpecific);
}

export function selectApprovalRoute<T extends ApprovalRouteCandidate>(
  routes: T[],
  workflowCode: string,
  locationId: string | null,
  requesterPersonId: string | null = null
) {
  return routes
    .filter((route) => (route.workflow_code === null || route.workflow_code === workflowCode)
      && (route.location_id === null || route.location_id === locationId)
      && (!route.requester_person_id || route.requester_person_id === requesterPersonId))
    .sort((left, right) => routeSpecificity(right, workflowCode, locationId, requesterPersonId)
      - routeSpecificity(left, workflowCode, locationId, requesterPersonId)
      || left.priority - right.priority
      || left.id.localeCompare(right.id))[0] ?? null;
}

