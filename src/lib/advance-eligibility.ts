export type AdvanceEligibilityInput = {
  currentPeopleAssignment: boolean;
  profileActive: boolean;
  profileStatus: unknown;
};

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
