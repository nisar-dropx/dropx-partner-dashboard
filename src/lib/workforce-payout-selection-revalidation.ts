import type { WorkforcePayoutRow } from "../components/workforce-payout-table.tsx";
import { isWorkforcePayoutCalculationPublishable } from "./workforce-payout-publication-eligibility.ts";
import {
  workforcePayoutCalculationHash,
  workforcePayoutLocationSetHash,
  workforcePayoutPublicationSnapshotHash
} from "./workforce-payout-publication.ts";
import {
  buildWorkforcePayoutPublicationSnapshot,
  type WorkforcePayoutPublicationSnapshot
} from "./workforce-payout-publication-snapshot.ts";

export type SignedWorkforcePayoutSelection = {
  calculationHash: string;
  locationId: string;
  locationSetHash: string;
  subjectId: string;
};

export type RevalidatedWorkforcePayoutSelection = SignedWorkforcePayoutSelection & {
  snapshot: WorkforcePayoutPublicationSnapshot;
  snapshotHash: string;
};

type RevalidationResult = {
  entries: RevalidatedWorkforcePayoutSelection[];
  error: null;
} | {
  entries: [];
  error: string;
};

function identityKey(subjectId: unknown, locationId: unknown) {
  return `${String(subjectId ?? "").toLowerCase()}|${String(locationId ?? "").toLowerCase()}`;
}

export function revalidateSelectedWorkforcePayoutRows(input: {
  dependencyHash: string;
  periodEnd: string;
  periodStart: string;
  rows: WorkforcePayoutRow[];
  selections: SignedWorkforcePayoutSelection[];
}): RevalidationResult {
  const selectedSubjects = new Set(input.selections.map((selection) => selection.subjectId.toLowerCase()));
  const publishableRows = input.rows.filter((row) => {
    const subjectId = String(row.reviewSubjectId ?? "").toLowerCase();
    return selectedSubjects.has(subjectId)
      && Boolean(row.locationId)
      && row.paymentDetailsAvailable
      && isWorkforcePayoutCalculationPublishable(row.status);
  });
  const rowsByIdentity = new Map<string, WorkforcePayoutRow[]>();
  publishableRows.forEach((row) => {
    const key = identityKey(row.reviewSubjectId, row.locationId);
    rowsByIdentity.set(key, [...(rowsByIdentity.get(key) ?? []), row]);
  });

  for (const subjectId of selectedSubjects) {
    const signed = input.selections.filter((selection) => selection.subjectId.toLowerCase() === subjectId);
    const expectedLocationHashes = new Set(signed.map((selection) => selection.locationSetHash));
    const currentLocations = publishableRows
      .filter((row) => String(row.reviewSubjectId ?? "").toLowerCase() === subjectId)
      .map((row) => String(row.locationId));
    if (expectedLocationHashes.size !== 1
      || workforcePayoutLocationSetHash(currentLocations) !== [...expectedLocationHashes][0]) {
      return {
        entries: [],
        error: "A selected Workforce member's payout locations changed. Refresh the worksheet and review the latest mapping."
      };
    }
  }

  const entries: RevalidatedWorkforcePayoutSelection[] = [];
  for (const selection of input.selections) {
    const candidates = rowsByIdentity.get(identityKey(selection.subjectId, selection.locationId)) ?? [];
    if (candidates.length !== 1
      || !selection.calculationHash
      || workforcePayoutCalculationHash(candidates[0], input.periodStart, input.periodEnd) !== selection.calculationHash) {
      return {
        entries: [],
        error: "One or more selected payout amounts or payment details changed. Refresh the worksheet and review the recalculated amounts."
      };
    }
    const snapshot = buildWorkforcePayoutPublicationSnapshot(
      candidates[0],
      input.periodStart,
      input.periodEnd,
      input.dependencyHash
    );
    entries.push({
      ...selection,
      snapshot,
      snapshotHash: workforcePayoutPublicationSnapshotHash(snapshot)
    });
  }
  return { entries, error: null };
}
