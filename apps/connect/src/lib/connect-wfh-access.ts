import "server-only";

import { supabaseAdmin } from "./supabase-admin";

export type ConnectWfhPolicy = {
  is_enabled: boolean;
  eligible_designation_ids: string[];
  max_request_days: number;
  max_monthly_days: number | null;
  max_yearly_days: number | null;
  allow_backdated: boolean;
  requires_hr_finalization: boolean;
  designation_rules: Record<string, { is_enabled: boolean; max_request_days: number; max_monthly_days: number }>;
  person_exceptions: Record<string, { valid_until: string | null; max_request_days: number; max_monthly_days: number }>;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

export async function loadConnectWfhPolicies(companyIds: string[]) {
  const unique = [...new Set(companyIds.filter(Boolean))];
  const map = new Map<string, ConnectWfhPolicy>();
  if (!unique.length) return map;
  const [policyResult, ruleResult, exceptionResult] = await Promise.all([
    db().from("hr_wfh_policies")
      .select("company_id,is_enabled,eligible_designation_ids,max_request_days,max_monthly_days,max_yearly_days,allow_backdated,requires_hr_finalization")
      .in("company_id", unique),
    db().from("hr_wfh_designation_rules")
      .select("company_id,designation_id,is_enabled,max_request_days,max_monthly_days")
      .in("company_id", unique),
    db().from("hr_wfh_person_exceptions")
      .select("company_id,person_id,valid_until,max_request_days,max_monthly_days")
      .in("company_id", unique)
  ]);
  if (policyResult.error) {
    if (/does not exist|schema cache/i.test(policyResult.error.message)) return map;
    throw new Error(policyResult.error.message);
  }
  const ruleRows = ruleResult.error && /does not exist|schema cache/i.test(ruleResult.error.message) ? [] : ruleResult.data ?? [];
  const exceptionRows = exceptionResult.error && /does not exist|schema cache/i.test(exceptionResult.error.message) ? [] : exceptionResult.data ?? [];
  if (ruleResult.error && !/does not exist|schema cache/i.test(ruleResult.error.message)) throw new Error(ruleResult.error.message);
  if (exceptionResult.error && !/does not exist|schema cache/i.test(exceptionResult.error.message)) throw new Error(exceptionResult.error.message);
  for (const row of policyResult.data ?? []) {
    map.set(String(row.company_id), {
      is_enabled: Boolean(row.is_enabled),
      eligible_designation_ids: (row.eligible_designation_ids ?? []) as string[],
      max_request_days: Number(row.max_request_days ?? 30),
      max_monthly_days: row.max_monthly_days == null ? null : Number(row.max_monthly_days),
      max_yearly_days: row.max_yearly_days == null ? null : Number(row.max_yearly_days),
      allow_backdated: Boolean(row.allow_backdated),
      requires_hr_finalization: row.requires_hr_finalization !== false,
      designation_rules: {},
      person_exceptions: {}
    });
  }
  for (const row of ruleRows) {
    const policy = map.get(String(row.company_id));
    if (!policy) continue;
    policy.designation_rules[String(row.designation_id)] = {
      is_enabled: Boolean(row.is_enabled),
      max_request_days: Number(row.max_request_days),
      max_monthly_days: Number(row.max_monthly_days)
    };
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  for (const row of exceptionRows) {
    if (row.valid_until && String(row.valid_until) < today) continue;
    const policy = map.get(String(row.company_id));
    if (!policy) continue;
    policy.person_exceptions[String(row.person_id)] = {
      valid_until: row.valid_until ? String(row.valid_until) : null,
      max_request_days: Number(row.max_request_days),
      max_monthly_days: Number(row.max_monthly_days)
    };
  }
  return map;
}

export function resolveConnectWfhAccess(input: {
  policy: ConnectWfhPolicy | null | undefined;
  designationId: string | null | undefined;
  personId?: string | null | undefined;
}) {
  if (!input.policy?.is_enabled) return null;
  const exception = input.personId ? input.policy.person_exceptions[input.personId] : null;
  if (exception) return {
    source: "person_exception" as const,
    max_request_days: exception.max_request_days,
    max_monthly_days: exception.max_monthly_days,
    max_yearly_days: input.policy.max_yearly_days
  };
  if (!input.designationId) return null;
  const rule = input.policy.designation_rules[input.designationId];
  if (rule) return rule.is_enabled ? {
    source: "designation" as const,
    max_request_days: rule.max_request_days,
    max_monthly_days: rule.max_monthly_days,
    max_yearly_days: input.policy.max_yearly_days
  } : null;
  if (!input.policy.eligible_designation_ids.includes(input.designationId)) return null;
  return {
    source: "legacy_designation" as const,
    max_request_days: input.policy.max_request_days,
    max_monthly_days: input.policy.max_monthly_days,
    max_yearly_days: input.policy.max_yearly_days
  };
}

export function connectWfhEligible(input: Parameters<typeof resolveConnectWfhAccess>[0]) {
  return Boolean(resolveConnectWfhAccess(input));
}
