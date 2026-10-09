type AdvanceSelectionRow = {
  reviewSubjectId?: string | null;
};

export type WorkforcePayoutPublicationLockState = "locked" | "unlocked";

export type WorkforcePayoutMappingLockSelectionRow = {
  reviewSubjectId?: string | null;
  publicationLockState?: WorkforcePayoutPublicationLockState | null;
};

export function duplicateAdvanceWorkforceIds(rows: AdvanceSelectionRow[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const workforceId = String(row.reviewSubjectId ?? "").trim();
    if (!workforceId) continue;
    if (seen.has(workforceId)) duplicates.add(workforceId);
    else seen.add(workforceId);
  }
  return duplicates;
}

export function workforcePayoutMappingLockSelectionIds(
  rows: readonly WorkforcePayoutMappingLockSelectionRow[],
  publicationLockState: WorkforcePayoutPublicationLockState
) {
  const seen = new Set<string>();
  const workforceIds: string[] = [];

  for (const row of rows) {
    if (row.publicationLockState !== publicationLockState) continue;

    const workforceId = String(row.reviewSubjectId ?? "").trim();
    if (!workforceId || seen.has(workforceId)) continue;

    seen.add(workforceId);
    workforceIds.push(workforceId);
  }

  return workforceIds;
}
