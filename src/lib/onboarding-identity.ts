export type OnboardingIdentityMatch = {
  source_type: string;
  source_id: string;
  display_name: string | null;
  designation_id: string | null;
  designation_code: string | null;
  designation_name: string | null;
  profile_status: string | null;
};

export type OnboardingIdentityEvaluation = {
  normalizedMobile: string;
  exactMatches: OnboardingIdentityMatch[];
  otherMatches: OnboardingIdentityMatch[];
};

type RpcClient = {
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function matches(value: unknown): OnboardingIdentityMatch[] {
  return Array.isArray(value) ? value.filter((item): item is OnboardingIdentityMatch => Boolean(item && typeof item === "object")) : [];
}

export function parseOnboardingIdentityEvaluation(value: unknown): OnboardingIdentityEvaluation {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    normalizedMobile: String(result.normalized_mobile ?? ""),
    exactMatches: matches(result.exact_matches),
    otherMatches: matches(result.other_matches)
  };
}

function existingProfile(match: OnboardingIdentityMatch | undefined) {
  if (!match) return "an existing profile";
  const name = match.display_name || "an existing person";
  const designation = match.designation_name || match.designation_code || "another designation";
  return `${name} (${designation})`;
}

export function assertOnboardingIdentityAllowed(evaluation: OnboardingIdentityEvaluation, allowDifferentWorkforceDesignation: boolean) {
  if (evaluation.exactMatches.length) {
    throw new Error(`This mobile number is already registered to ${existingProfile(evaluation.exactMatches[0])}. Continue the existing profile; the same designation cannot be registered twice.`);
  }
  if (evaluation.otherMatches.length && !allowDifferentWorkforceDesignation) {
    throw new Error(`This mobile number already belongs to ${existingProfile(evaluation.otherMatches[0])}. Only a different Workforce engagement can continue, and it requires lifecycle approval.`);
  }
}

export async function evaluateOnboardingIdentity({ client, companyId, mobile, designationId, designationName }: {
  client: RpcClient;
  companyId: string;
  mobile: string;
  designationId?: string | null;
  designationName?: string | null;
}) {
  const result = await client.rpc("evaluate_onboarding_identity", {
    p_company_id: companyId,
    p_mobile: mobile,
    p_designation_id: designationId ?? null,
    p_designation_name: designationName ?? null,
    p_exclude_source: null,
    p_exclude_id: null
  });
  if (result.error) throw new Error(result.error.message);
  return parseOnboardingIdentityEvaluation(result.data);
}

export function identityExceptionEventMetadata(evaluation: OnboardingIdentityEvaluation) {
  if (!evaluation.otherMatches.length) return {};
  return {
    identity_exception_required: true,
    identity_exception_reason: "existing_person_different_designation",
    existing_profiles: evaluation.otherMatches.map((match) => ({
      source_type: match.source_type,
      source_id: match.source_id,
      display_name: match.display_name,
      designation_code: match.designation_code,
      designation_name: match.designation_name,
      profile_status: match.profile_status
    }))
  };
}
