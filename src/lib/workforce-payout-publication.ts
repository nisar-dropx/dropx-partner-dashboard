import { createHash } from "node:crypto";

import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import {
  buildWorkforcePayoutPublicationSnapshot,
  type WorkforcePayoutPublicationSnapshot
} from "./workforce-payout-publication-snapshot.ts";

export {
  buildWorkforcePayoutPublicationSnapshot,
  type WorkforcePayoutPublicationSnapshot
} from "./workforce-payout-publication-snapshot.ts";

export function workforcePayoutPublicationSnapshotHash(snapshot: WorkforcePayoutPublicationSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function workforcePayoutLocationSetHash(locationIds: Iterable<unknown>) {
  const normalized = [...new Set([...locationIds]
    .map((locationId) => String(locationId ?? "").trim().toLowerCase())
    .filter(Boolean))]
    .sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function workforcePayoutCalculationHash(
  row: WorkforcePayoutRow,
  periodStart: string,
  periodEnd: string
) {
  return workforcePayoutPublicationSnapshotHash(
    buildWorkforcePayoutPublicationSnapshot(row, periodStart, periodEnd, "")
  );
}
