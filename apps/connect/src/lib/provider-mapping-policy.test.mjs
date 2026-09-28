import test from "node:test";
import assert from "node:assert/strict";
import { requiresProviderMappingActivation } from "./provider-mapping-policy.ts";

const input = { workspace: "workforce", profileType: "workforce", designationId: "designation", activationGateEnabled: true, providerMappingRequired: true };

test("provider mapping activation is required only when both designation controls enable it", () => {
  assert.equal(requiresProviderMappingActivation(input), true);
  assert.equal(requiresProviderMappingActivation({ ...input, providerMappingRequired: false }), false);
  assert.equal(requiresProviderMappingActivation({ ...input, activationGateEnabled: false }), false);
});

test("people workspaces and non-canonical profiles never enter provider activation", () => {
  assert.equal(requiresProviderMappingActivation({ ...input, workspace: "people" }), false);
  assert.equal(requiresProviderMappingActivation({ ...input, profileType: "employee" }), false);
  assert.equal(requiresProviderMappingActivation({ ...input, designationId: null }), false);
});
