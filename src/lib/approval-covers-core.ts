export type ApprovalCoverTarget = { personId: string; name: string };

/** Pure filter for which cover rows apply. */
export function selectActiveCoverRows(
  rows: Array<{ approver_person_id: string; delegate_person_id: string; workflow_code: string | null; reason: string | null; effective_from: string }>,
  workflowCode?: string | null,
) {
  // All-workflow covers always apply. Workflow-specific covers only when that workflow is requested.
  return rows
    .filter((row) => !row.workflow_code || (workflowCode != null && workflowCode !== "" && row.workflow_code === workflowCode))
    .sort((left, right) => Number(Boolean(right.workflow_code)) - Number(Boolean(left.workflow_code)) || right.effective_from.localeCompare(left.effective_from));
}

/** Replace covered people with their acting cover. */
export function remapApproverPeople(
  people: Array<{ personId: string; name: string }>,
  covers: Map<string, ApprovalCoverTarget>,
) {
  const out = new Map<string, ApprovalCoverTarget>();
  for (const person of people) {
    const next = covers.get(person.personId) ?? person;
    out.set(next.personId, next);
  }
  return [...out.values()];
}
