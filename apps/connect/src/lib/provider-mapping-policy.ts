export function requiresProviderMappingActivation(input: {
  workspace: "people" | "workforce";
  profileType: string;
  designationId: string | null;
  activationGateEnabled: boolean;
  providerMappingRequired: boolean;
}) {
  return input.workspace === "workforce"
    && input.profileType === "workforce"
    && Boolean(input.designationId)
    && input.activationGateEnabled
    && input.providerMappingRequired;
}
