import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { buildWorkforcePayoutPublicationSnapshot } from "./workforce-payout-publication-snapshot.ts";

/**
 * Helpers intentionally do not have a canonical Workforce row. Keep their
 * frozen payout identity explicit instead of overloading workforce_id.
 *
 * This builder is client-safe so the worksheet can include the exact snapshot
 * that was signed by the server in the notification request.
 */
export function buildHelperPayoutPublicationSnapshot(
  row: WorkforcePayoutRow,
  periodStart: string,
  periodEnd: string
) {
  const workforceShape = buildWorkforcePayoutPublicationSnapshot(row, periodStart, periodEnd, "");
  const { workforce_id: _workforceId, ...item } = workforceShape.item;
  return {
    ...workforceShape,
    source: "helper_payout_worksheet" as const,
    dependency_hash: "",
    item: {
      ...item,
      helper_id: String(row.reviewSubjectId)
    }
  };
}

export type HelperPayoutPublicationSnapshot = ReturnType<typeof buildHelperPayoutPublicationSnapshot>;
