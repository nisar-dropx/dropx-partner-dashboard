import "server-only";

import { isWfhHardBlockedDesignation, type DesignationLabel } from "./approval-designation-labels";
import { supabaseAdmin } from "./supabase-admin";

export type ConnectWfhPolicy = {
  is_enabled: boolean;
  eligible_designation_ids: string[];
  max_request_days: number;
  allow_backdated: boolean;
  requires_hr_finalization: boolean;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

export async function loadConnectWfhPolicies(companyIds: string[]) {
  const unique = [...new Set(companyIds.filter(Boolean))];
  const map = new Map<string, ConnectWfhPolicy>();
  if (!unique.length) return map;
  const result = await db()
    .from("hr_wfh_policies")
    .select("company_id,is_enabled,eligible_designation_ids,max_request_days,allow_backdated,requires_hr_finalization")
    .in("company_id", unique);
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) return map;
    throw new Error(result.error.message);
  }
  for (const row of result.data ?? []) {
    map.set(String(row.company_id), {
      is_enabled: Boolean(row.is_enabled),
      eligible_designation_ids: (row.eligible_designation_ids ?? []) as string[],
      max_request_days: Number(row.max_request_days ?? 30),
      allow_backdated: Boolean(row.allow_backdated),
      requires_hr_finalization: row.requires_hr_finalization !== false
    });
  }
  return map;
}

export function connectWfhEligible(input: {
  policy: ConnectWfhPolicy | null | undefined;
  designationId: string | null | undefined;
  designation: DesignationLabel | null | undefined;
}) {
  if (!input.policy?.is_enabled) return false;
  if (!input.designationId) return false;
  if (isWfhHardBlockedDesignation(input.designation)) return false;
  return input.policy.eligible_designation_ids.includes(input.designationId);
}
