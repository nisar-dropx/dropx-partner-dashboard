import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import { loadStablePayoutWorksheet } from "@/lib/stable-payout-worksheet";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import {
  revalidateSelectedWorkforcePayoutRows,
  type SignedWorkforcePayoutSelection
} from "@/lib/workforce-payout-selection-revalidation";

export async function revalidateWorkforcePayoutPublicationSelections(input: {
  authorization: AuthorizationContext;
  companyId: string;
  periodEnd: string;
  periodStart: string;
  selections: SignedWorkforcePayoutSelection[];
}) {
  const workforceIds = [...new Set(input.selections.map((selection) => selection.subjectId))];
  const loaded = await loadStablePayoutWorksheet({
    loadRows: () => loadWorkforcePayoutRows(
      input.companyId,
      input.authorization,
      input.periodStart,
      input.periodEnd,
      { workforceIds }
    ),
    loadDependency: () => workforcePayoutDependencyHash(
      input.companyId,
      input.periodStart,
      input.periodEnd
    ),
    maxAttempts: 3
  });
  if (loaded.error || !loaded.dependencyHash) {
    return {
      entries: [],
      dependencyHash: null,
      error: loaded.error || "Payout inputs are updating. Try sending the notification again.",
      updating: true
    } as const;
  }
  const revalidated = revalidateSelectedWorkforcePayoutRows({
    dependencyHash: loaded.dependencyHash,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    rows: loaded.rows,
    selections: input.selections
  });
  return {
    ...revalidated,
    dependencyHash: loaded.dependencyHash,
    updating: false
  } as const;
}
