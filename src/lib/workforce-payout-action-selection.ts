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
};

export type WorkforcePayoutBankSelectionIndexEntry = {
  rowIds: string[];
  availableToPay: number;
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
  const totals = new Map<string, {
    netAmount: number;
    paidAmount: number;
    processingAmount: number;
    rowIds: Set<string>;
  }>();

  for (const row of rows) {
    const workforceId = String(row.reviewSubjectId ?? "").trim();
    if (!workforceId) continue;

    const current = totals.get(workforceId) ?? {
      netAmount: 0,
      paidAmount: 0,
      processingAmount: 0,
      rowIds: new Set<string>()
    };
    if (!current.rowIds.has(row.id)) {
      current.rowIds.add(row.id);
      current.netAmount = money(current.netAmount + (Number(row.netAmount) || 0));
    }
    // The server preview is repeated on every location row. Use the largest
    // ledger value rather than summing duplicates across those rows.
    current.paidAmount = Math.max(current.paidAmount, Number(row.paymentSummary?.paidAmount ?? 0) || 0);
    current.processingAmount = Math.max(current.processingAmount, Number(row.paymentSummary?.processingAmount ?? 0) || 0);
    totals.set(workforceId, current);
  }

  return new Map([...totals].map(([workforceId, total]) => [
    workforceId,
    money(Math.max(0, total.netAmount - total.paidAmount - total.processingAmount))
  ]));
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
    if (!workforceId) continue;

    const current = index.get(workforceId);
    if (current) {
      current.rowIds.push(row.id);
      continue;
    }

    index.set(workforceId, {
      rowIds: [row.id],
      availableToPay: getAvailableToPay(row)
    });
  }

  return index;
}

export function selectedWorkforcePayoutBankIds<Row extends WorkforcePayoutBankSelectionRow>(
  selectedRows: readonly Row[],
  isEligible: (row: Row) => boolean
) {
  const workforceIds = new Set<string>();

  for (const row of selectedRows) {
    if (!isEligible(row)) continue;
    const workforceId = String(row.reviewSubjectId ?? "").trim();
    if (workforceId) workforceIds.add(workforceId);
  }

  return workforceIds;
}

export function resolveWorkforcePayoutBankSelection(
  index: ReadonlyMap<string, WorkforcePayoutBankSelectionIndexEntry>,
  selectedRowIds: ReadonlySet<string>,
  selectedWorkforceIds: ReadonlySet<string>
) {
  const workforceIds: string[] = [];
  let totalAmount = 0;

  for (const workforceId of selectedWorkforceIds) {
    const entry = index.get(workforceId);
    // A bank instruction is authoritative at Workforce-profile/month level.
    // One checked location row therefore opts the profile into the bank action;
    // the server candidate still includes every required publication (including
    // unselected location deductions) before it creates the single instruction.
    if (!entry?.rowIds.some((rowId) => selectedRowIds.has(rowId))) continue;

    workforceIds.push(workforceId);
    totalAmount += entry.availableToPay;
  }

  return { workforceIds, totalAmount };
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
