import { createHash } from "node:crypto";

/**
 * Bulk workbooks remain content-idempotent. Manual edits additionally bind the
 * generated CSV to one editor operation so A -> B -> A is a valid new change,
 * while a retry of the same preview/commit operation keeps the same fingerprint.
 */
export function workforcePayoutImportFingerprint(
  bytes: Uint8Array,
  manualOperationId?: string | null
) {
  const hash = createHash("sha256").update(bytes);
  if (manualOperationId) {
    hash.update("\0manual-operation:", "utf8");
    hash.update(manualOperationId.toLowerCase(), "utf8");
  }
  return hash.digest("hex");
}
