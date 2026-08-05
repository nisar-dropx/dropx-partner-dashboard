import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

const SOURCES = [
  ["employees", "employee"], ["field_executives", "field_executive"], ["contractors", "contractor"], ["vendors", "vendor"], ["workers", "worker"]
] as const;
type Profile = { id: string; statutory_applicability: string[] | null; pf_uan: string | null; esi_no: string | null; driving_license_exp_date: string | null; vehicle_reg_no: string | null; vehicle_reg_exp_date: string | null; vehicle_insurance_exp_date: string | null; vehicle_pollution_exp_date: string | null; updated_at: string | null };
type Issue = { type: string; id: string; rule: string; updated: string };
const text = (value: unknown) => String(value ?? "").trim();
const issueKey = (issue: Issue) => `${issue.type}:${issue.id}:${issue.rule}`;

export async function loadPeopleExceptionCount(authorization: AuthorizationContext) {
  if (!supabaseAdmin || !authorization.companyId) return 0;
  const results = await Promise.all(SOURCES.map(async ([table, type]) => {
    let query = supabaseAdmin!.from(table).select("id, statutory_applicability, pf_uan, esi_no, driving_license_exp_date, vehicle_reg_no, vehicle_reg_exp_date, vehicle_insurance_exp_date, vehicle_pollution_exp_date, updated_at").eq("company_id", authorization.companyId!).eq(type === "employee" ? "profile_completion_status" : "onboarding_status", "active");
    if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner) query = query.in("location_id", authorization.locationScopeIds);
    const result = await query;
    return { type, rows: (result.data ?? []) as Profile[], error: result.error };
  }));
  if (results.some((result) => result.error)) return 0;
  const active = new Set<string>();
  const issues: Issue[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const result of results) for (const row of result.rows) {
    active.add(`${result.type}:${row.id}`);
    const updated = row.updated_at || new Date(0).toISOString();
    const add = (rule: string) => issues.push({ type: result.type, id: row.id, rule, updated });
    const statutory = row.statutory_applicability ?? [];
    if (statutory.includes("pf") && !text(row.pf_uan)) add("pf_missing");
    if (statutory.includes("esi") && !text(row.esi_no)) add("esi_missing");
    if (row.driving_license_exp_date && row.driving_license_exp_date < today) add("dl_expired");
    if (text(row.vehicle_reg_no) && row.vehicle_reg_exp_date && row.vehicle_reg_exp_date < today) add("vehicle_registration_expired");
    if (text(row.vehicle_reg_no) && row.vehicle_insurance_exp_date && row.vehicle_insurance_exp_date < today) add("vehicle_insurance_expired");
    if (text(row.vehicle_reg_no) && row.vehicle_pollution_exp_date && row.vehicle_pollution_exp_date < today) add("vehicle_pollution_expired");
  }
  const [verifications, resolutions] = await Promise.all([
    supabaseAdmin.from("connect_profile_verifications").select("account_id, profile_type, kind, message, updated_at").eq("company_id", authorization.companyId).eq("verified", false).neq("kind", "bank"),
    supabaseAdmin.from("people_exception_resolutions").select("profile_type, profile_id, rule_code, source_updated_at").eq("company_id", authorization.companyId)
  ]);
  if (verifications.error || resolutions.error) return issues.length;
  for (const row of verifications.data ?? []) if (active.has(`${row.profile_type}:${row.account_id}`) && !/partial/i.test(text(row.message))) issues.push({ type: row.profile_type, id: row.account_id, rule: `verification_${row.kind}`, updated: row.updated_at });
  const cleared = new Map((resolutions.data ?? []).map((row) => [`${row.profile_type}:${row.profile_id}:${row.rule_code}`, row.source_updated_at]));
  return issues.filter((issue) => cleared.get(issueKey(issue)) !== issue.updated).length;
}
