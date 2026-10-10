import { createHash } from "node:crypto";

import type { HelperPayoutPublicationSnapshot } from "./helper-payout-publication-snapshot.ts";

export {
  buildHelperPayoutPublicationSnapshot,
  type HelperPayoutPublicationSnapshot
} from "./helper-payout-publication-snapshot.ts";

export function helperPayoutPublicationSnapshotHash(snapshot: HelperPayoutPublicationSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
