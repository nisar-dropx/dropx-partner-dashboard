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

export function assertOnboardingIdentityAllowed(evaluation: OnboardingIdentityEvaluation) {
  // Mobile numbers are contact details and may be shared by independent People IDs.
  void evaluation;
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
  void evaluation;
  return {};
}
