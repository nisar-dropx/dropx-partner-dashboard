export type ConnectAccountIdentity = {
  id: string;
  companyId: string;
  profileType: string;
};

export type ConnectWorkforceAccountStatus = {
  onboarding_status?: string | null;
  lifecycle_status?: string | null;
  is_active?: boolean | null;
  deleted_at?: unknown;
  deactivated_at?: unknown;
};

const onboardingAccessStatuses = new Set([
  "approved",
  "pending",
  "returned",
  "under_review"
]);

const onboardingWorkforceLifecycles = new Set([
  "",
  "active",
  "onboarding",
  "pending"
]);

const blockedWorkforceLifecycles = new Set([
  "cancelled",
  "closed",
  "deactivated",
  "exited",
  "inactive",
  "offboarded",
  "resigned",
  "settled",
  "suspended",
  "terminated"
]);

function normalizedStatus(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Connect remains available while an applicant completes onboarding, but an
 * operational account must still be canonically active. This prevents a stale
 * `onboarding_status = active` value from restoring access after Workforce
 * Lifecycle (or a manual profile edit) has deactivated the person.
 */
export function eligibleConnectWorkforceAccount(row: ConnectWorkforceAccountStatus) {
  if (row.deleted_at || row.deactivated_at) return false;

  const onboardingStatus = normalizedStatus(row.onboarding_status) || "pending";
  const lifecycleStatus = normalizedStatus(row.lifecycle_status);
  if (blockedWorkforceLifecycles.has(lifecycleStatus)) return false;

  // Active workers can legitimately remain signed in during non-terminal exit
  // steps such as resignation_pending or settlement_pending. Historical rows
  // may also carry lifecycle=onboarding until the activation invariant repairs
  // them; is_active=true remains mandatory in every operational case.
  if (onboardingStatus === "active") return row.is_active === true;
  return onboardingAccessStatuses.has(onboardingStatus) &&
    onboardingWorkforceLifecycles.has(lifecycleStatus);
}

function accountIdentityKey(account: ConnectAccountIdentity) {
  return `${account.companyId}:${account.profileType}:${account.id}`;
}

export function sameConnectAccountIdentitySet(
  before: ConnectAccountIdentity[],
  after: ConnectAccountIdentity[]
) {
  if (before.length !== after.length) return false;
  const beforeKeys = before.map(accountIdentityKey).sort();
  const afterKeys = after.map(accountIdentityKey).sort();
  return beforeKeys.every((key, index) => key === afterKeys[index]);
}
