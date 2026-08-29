export type ConnectReportingRelationship = {
  subject_assignment_id: string;
  manager_assignment_id: string;
};

export function collectConnectReporteeAssignmentIds(
  managerAssignmentId: string,
  relationships: ConnectReportingRelationship[],
  includeEntireTeam: boolean
) {
  const childrenByManager = new Map<string, string[]>();
  for (const relationship of relationships) {
    if (!relationship.manager_assignment_id || !relationship.subject_assignment_id) continue;
    const children = childrenByManager.get(relationship.manager_assignment_id) ?? [];
    children.push(relationship.subject_assignment_id);
    childrenByManager.set(relationship.manager_assignment_id, children);
  }

  const direct = [...new Set(childrenByManager.get(managerAssignmentId) ?? [])];
  if (!includeEntireTeam) return new Set(direct);

  const descendants = new Set<string>();
  const visited = new Set<string>([managerAssignmentId]);
  const queue = [...direct];
  while (queue.length) {
    const assignmentId = queue.shift();
    if (!assignmentId || visited.has(assignmentId)) continue;
    visited.add(assignmentId);
    descendants.add(assignmentId);
    for (const childId of childrenByManager.get(assignmentId) ?? []) {
      if (!visited.has(childId)) queue.push(childId);
    }
  }
  return descendants;
}

