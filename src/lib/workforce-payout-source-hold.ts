import { normalizePayoutIdentity } from "./workforce-payout-population.ts";

export type WorkforcePayoutSourceIdentity = {
  stationId: string;
  providerIdentity: string;
  providerMemberId: string;
};

export type WorkforcePayoutSourceHoldTarget = {
  stationId: string;
  providerIdentity: string;
  providerMemberId: string;
};

export function normalizeWorkforcePayoutSourceIdentity(
  identity: WorkforcePayoutSourceIdentity | null | undefined
): WorkforcePayoutSourceHoldTarget | null {
  const stationId = String(identity?.stationId ?? "").trim().toLowerCase();
  const providerIdentity = normalizePayoutIdentity(identity?.providerIdentity);
  const providerMemberId = normalizePayoutIdentity(identity?.providerMemberId);
  if (!stationId || !providerIdentity || !providerMemberId) return null;
  return { stationId, providerIdentity, providerMemberId };
}
export function workforcePayoutSourceIdentityKey(
  identity: WorkforcePayoutSourceIdentity | null | undefined
) {
  const normalized = normalizeWorkforcePayoutSourceIdentity(identity);
  return normalized
    ? `${normalized.stationId}|${normalized.providerIdentity}|${normalized.providerMemberId}`
    : "";
}
export function dedupeWorkforcePayoutSourceIdentities(
  identities: Array<WorkforcePayoutSourceIdentity | null | undefined>
) {
  const unique = new Map<string, WorkforcePayoutSourceIdentity>();
  identities.forEach((identity) => {
    const key = workforcePayoutSourceIdentityKey(identity);
    if (key && identity && !unique.has(key)) unique.set(key, identity);
  });
  return [...unique.values()];
}

export function workforcePayoutRowSourceIdentities(row: {
  paymentSourceIdentity?: WorkforcePayoutSourceIdentity;
  paymentSourceIdentities?: WorkforcePayoutSourceIdentity[];
}) {
  return dedupeWorkforcePayoutSourceIdentities([
    ...(row.paymentSourceIdentities ?? []),
    row.paymentSourceIdentity
  ]);
}

