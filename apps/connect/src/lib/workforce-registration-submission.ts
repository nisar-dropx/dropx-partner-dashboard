import type { NonEmployeeProfileType } from "./workforce-profiles";

type WorkforceRegistrationSubmissionInput = {
  accountId: string;
  companyId: string;
  currentStatus: string;
  manualReviewRequired: boolean;
  profileType: NonEmployeeProfileType;
  submittedAt: string;
};

type WorkforceOnboardingEvent = {
  company_id: string;
  event_code: "candidate_submitted";
  field_executive_id?: string;
  workforce_id?: string;
  from_status: string;
  to_status: "active" | "under_review";
  source_portal: "connect";
  remarks: string;
};

export function workforceRegistrationSubmission(input: WorkforceRegistrationSubmissionInput) {
  const legacyFieldExecutive = input.profileType === "field_executive";
  const canonicalWorkforce = input.profileType === "workforce";
  const onboardingStatus = legacyFieldExecutive || input.manualReviewRequired ? "under_review" : "active";
  const profilePatch: Record<string, unknown> = {
    onboarding_status: onboardingStatus,
    profile_return_remarks: null,
    profile_returned_at: null,
    is_active: !legacyFieldExecutive,
    ...((legacyFieldExecutive || canonicalWorkforce)
      ? { onboarding_submitted_at: input.submittedAt }
      : {}),
    ...(legacyFieldExecutive ? { lifecycle_status: "onboarding" } : {}),
    updated_at: input.submittedAt
  };

  let onboardingEvent: WorkforceOnboardingEvent | null = null;
  if (legacyFieldExecutive) {
    onboardingEvent = {
      company_id: input.companyId,
      field_executive_id: input.accountId,
      event_code: "candidate_submitted",
      from_status: input.currentStatus,
      to_status: "under_review",
      source_portal: "connect",
      remarks: "Applicant submitted profile and agreement for HO review."
    };
  } else if (canonicalWorkforce) {
    onboardingEvent = {
      company_id: input.companyId,
      workforce_id: input.accountId,
      event_code: "candidate_submitted",
      from_status: input.currentStatus,
      to_status: onboardingStatus,
      source_portal: "connect",
      remarks: "Applicant submitted Workforce registration in DropX One."
    };
  }

  return {
    canonicalWorkforce,
    legacyFieldExecutive,
    onboardingEvent,
    onboardingStatus,
    profilePatch
  };
}
