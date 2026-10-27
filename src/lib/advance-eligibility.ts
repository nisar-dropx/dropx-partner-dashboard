export type AdvanceEligibilityInput = {
  currentPeopleAssignment: boolean;
  profileActive: boolean;
  profileStatus: unknown;
};

export const ADVANCE_ELIGIBILITY_PERCENT = 25;

export function advanceEligibilityAmount(outstandingPay: unknown, committedAdvance: unknown = 0) {
  const outstanding = Math.max(0, Number(outstandingPay) || 0);
  const committed = Math.max(0, Number(committedAdvance) || 0);
  return Math.max(0, Math.round((outstanding * ADVANCE_ELIGIBILITY_PERCENT - committed * 100) + Number.EPSILON) / 100);
}

export function validAdvanceApprovalAmount(value: unknown, maximum: unknown) {
  const amount = Number(value);
  const cap = Math.max(0, Number(maximum) || 0);
  return Number.isFinite(amount) && amount > 0 && amount <= cap
    && Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001;
}

/**
 * People is the source of truth for pay self-service eligibility. The legacy
 * completion status remains a compatibility fallback for records that have not
 * yet been migrated into the People engagement/assignment model.
 */
export function isAdvanceEligible(input: AdvanceEligibilityInput) {
  if (!input.profileActive) return false;
  if (input.currentPeopleAssignment) return true;
  return String(input.profileStatus ?? "").trim().toLowerCase() === "active";
}
