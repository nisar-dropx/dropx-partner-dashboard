const legacyOnboardingEventCodes: Record<string, string> = {
  employees: "employee_onboarding",
  workforce: "field_executive_onboarding",
  field_executives: "field_executive_onboarding",
  vendors: "vendor_onboarding"
};

export function normalizeWorkforceCategoryCode(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function workforceOnboardingEventCode(categoryCode: unknown) {
  const normalized = normalizeWorkforceCategoryCode(categoryCode);
  return legacyOnboardingEventCodes[normalized] ?? `workforce_${normalized}_onboarding`;
}
