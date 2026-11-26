"use server";

import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canViewDsOperations,
  hasDsOperationsRole
} from "@/lib/ops-pulse/ds-live-performance-access";
import {
  updateDsMessagePolicy,
  type DsMessagePolicyUpdate
} from "@/lib/ops-pulse/ds-message-policy-store";
import type { DsMessagePolicy } from "@/lib/ops-pulse/ds-message-policy";

function canEditPolicies(authorization: Awaited<ReturnType<typeof getAuthorization>>) {
  if (!authorization) return false;
  if (hasDsOperationsRole(authorization)) return true;
  const grant = authorization.permissions?.ds_message_policies;
  return Boolean(grant?.canEdit || grant?.canAdd);
}

export async function saveDsMessagePolicyAction(input: {
  id: string;
  urgency: DsMessagePolicy["urgency"];
  frequency: DsMessagePolicy["frequency"];
  cooldownMinutes: number;
  thresholdSeconds: number | null;
  enabled: boolean;
}) {
  const authorization = await getAuthorization();
  if (!authorization || !canViewDsOperations(authorization, "ds_message_policies")) {
    return { ok: false as const, error: "Not allowed." };
  }
  if (!canEditPolicies(authorization)) {
    return { ok: false as const, error: "Edit permission required." };
  }
  const companyId = requireCompanyId(authorization);
  try {
    const payload: DsMessagePolicyUpdate = {
      id: input.id,
      urgency: input.urgency,
      frequency: input.frequency,
      cooldownMinutes: Number(input.cooldownMinutes),
      thresholdSeconds: input.thresholdSeconds,
      enabled: input.enabled
    };
    const row = await updateDsMessagePolicy(companyId, payload);
    return { ok: true as const, policy: row };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Save failed."
    };
  }
}