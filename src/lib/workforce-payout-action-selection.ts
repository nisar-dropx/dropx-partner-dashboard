type AdvanceSelectionRow = {
  reviewSubjectId?: string | null;
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
