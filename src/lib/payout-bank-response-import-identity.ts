import { createHash } from "node:crypto";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SCOPED_IMPORT_DOMAIN = "dropx:payout-bank-response:scoped:v1";

type PayoutBankResponseImportIdentityInput = {
  rawFileSha256: string;
  hasAllLocationAccess: boolean;
  includedReferences: Iterable<string>;
};

/**
 * Builds the value used by the existing response-import SHA uniqueness key.
 *
 * All-location imports deliberately retain the physical file SHA so imports
 * recorded before location-scoped finalization continue to replay exactly as
 * they did before. A scoped import is instead namespaced by the canonical set
 * of payment references actually sent to the finalizer. That lets two editors
 * safely process different permitted portions of one physical bank response,
 * while retries of the same portion remain idempotent.
 */
export function payoutBankResponseImportIdentity({
  rawFileSha256,
  hasAllLocationAccess,
  includedReferences
}: PayoutBankResponseImportIdentityInput) {
  const normalizedRawSha256 = rawFileSha256.trim().toLowerCase();
  if (!SHA256_HEX.test(normalizedRawSha256)) {
    throw new Error("A valid raw bank response SHA-256 is required.");
  }
  if (hasAllLocationAccess) return normalizedRawSha256;

  const references = [...new Set(
    [...includedReferences]
      .map((reference) => String(reference ?? "").trim().toUpperCase())
      .filter(Boolean)
  )].sort();
  if (!references.length) {
    throw new Error("A scoped bank response import requires at least one permitted payment reference.");
  }

  return createHash("sha256")
    .update(`${SCOPED_IMPORT_DOMAIN}\n${normalizedRawSha256}\n${references.join("\n")}`, "utf8")
    .digest("hex");
}
