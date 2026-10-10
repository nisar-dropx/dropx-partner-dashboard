type AdvanceSelectionRow = {
  reviewSubjectId?: string | null;
};

export type WorkforcePayoutPublicationLockState = "locked" | "unlocked";

export type WorkforcePayoutMappingLockSelectionRow = {
  reviewSubjectId?: string | null;
  publicationLockState?: WorkforcePayoutPublicationLockState | null;
};

export type WorkforcePayoutBankSelectionRow = {
  id: string;
  reviewSubjectId?: string | null;
  locationId?: string | null;
};

export type WorkforcePayoutBankSelectionIndexEntry = {
  workforceId: string;
  stationId: string;
  availableToPay: number;
};

export type WorkforcePayoutBankRowSelection = {
  workforceId: string;
  stationId: string;
};

export type WorkforcePayoutPreliminaryBalanceRow = WorkforcePayoutBankSelectionRow & {
  netAmount: number;
  paymentSummary?: {
    paidAmount: number;
    processingAmount: number;
  } | null;
};

function money(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function buildWorkforcePayoutPreliminaryBalanceIndex<
  Row extends WorkforcePayoutPreliminaryBalanceRow
>(rows: readonly Row[]) {
  const balances = new Map<string, number>();

  for (const row of rows) {
    const workforceId = String(row.reviewSubjectId ?? "").trim();
    const stationId = String(row.locationId ?? "").trim();
    if (!workforceId || !stationId) continue;
    balances.set(row.id, money(Math.max(
      0,
      (Number(row.netAmount) || 0)
        - (Number(row.paymentSummary?.paidAmount ?? 0) || 0)
        - (Number(row.paymentSummary?.processingAmount ?? 0) || 0)
    )));
  }

  return balances;
}

export function buildWorkforcePayoutBankSelectionIndex<Row extends WorkforcePayoutBankSelectionRow>(
  rows: readonly Row[],
  isEligible: (row: Row) => boolean,
  getAvailableToPay: (row: Row) => number
) {
  const index = new Map<string, WorkforcePayoutBankSelectionIndexEntry>();

  for (const row of rows) {
    if (!isEligible(row)) continue;

    const workforceId = String(row.reviewSubjectId ?? "").trim();
    const stationId = String(row.locationId ?? "").trim();
    if (!workforceId || !stationId) continue;

    index.set(row.id, {
      workforceId,
      stationId,
      availableToPay: getAvailableToPay(row)
    });
  }

  return index;
}

export function selectedWorkforcePayoutBankRows<Row extends WorkforcePayoutBankSelectionRow>(
  selectedRows: readonly Row[],
  isEligible: (row: Row) => boolean
) {
  const selections = new Map<string, WorkforcePayoutBankRowSelection>();

  for (const row of selectedRows) {
    if (!isEligible(row)) continue;
    const workforceId = String(row.reviewSubjectId ?? "").trim();
    const stationId = String(row.locationId ?? "").trim();
    if (!workforceId || !stationId) continue;
    selections.set(`${workforceId}|${stationId}`, { workforceId, stationId });
  }

  return [...selections.values()].sort((left, right) =>
    left.workforceId.localeCompare(right.workforceId) || left.stationId.localeCompare(right.stationId)
  );
}

export function resolveWorkforcePayoutBankSelection(
  index: ReadonlyMap<string, WorkforcePayoutBankSelectionIndexEntry>,
  selectedRowIds: ReadonlySet<string>
) {
  const payoutRows: WorkforcePayoutBankRowSelection[] = [];
  let totalAmount = 0;

  for (const rowId of selectedRowIds) {
    const entry = index.get(rowId);
    if (!entry) continue;
    payoutRows.push({ workforceId: entry.workforceId, stationId: entry.stationId });
    totalAmount += entry.availableToPay;
  }

  payoutRows.sort((left, right) =>
    left.workforceId.localeCompare(right.workforceId) || left.stationId.localeCompare(right.stationId)
  );
  return { payoutRows, totalAmount: money(totalAmount) };
}

export function chunkPayoutRowsBySubject<Row extends { reviewSubjectId?: string | null }>(
  rows: readonly Row[],
  maximumRows: number
) {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
    throw new Error("The payout action chunk size must be a positive whole number.");
  }

  const groups = new Map<string, Row[]>();
  rows.forEach((row, index) => {
    const subjectId = String(row.reviewSubjectId ?? "").trim() || `unscoped:${index}`;
    groups.set(subjectId, [...(groups.get(subjectId) ?? []), row]);
  });

  const chunks: Row[][] = [];
  let current: Row[] = [];
  for (const group of groups.values()) {
    if (group.length > maximumRows) {
      throw new Error(`One payout profile has more than ${maximumRows} location rows and cannot be submitted safely.`);
    }
    if (current.length && current.length + group.length > maximumRows) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

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
