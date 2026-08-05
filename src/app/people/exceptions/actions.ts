"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const PROFILE_TABLES: Record<string, string> = { employee: "employees", field_executive: "field_executives", contractor: "contractors", vendor: "vendors", worker: "workers" };
const EDITABLE_FIELDS = new Set(["pf_uan", "esi_no", "bank_account_no", "ifsc", "ifsc_code", "pan_number", "aadhaar_number", "driving_license_no", "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date", "vehicle_pollution_exp_date"]);

function value(entry: FormDataEntryValue | null) { return String(entry ?? "").trim(); }

export async function updateAndClearPeopleException(formData: FormData) {
  const authorization = await requirePagePermission("people_exceptions", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) redirect("/people/exceptions?error=Database+connection+is+not+configured");

  const profileType = value(formData.get("profile_type"));
  const profileId = value(formData.get("profile_id"));
  const ruleCode = value(formData.get("rule_code"));
  const sourceUpdatedAt = value(formData.get("source_updated_at"));
  const table = PROFILE_TABLES[profileType];
  if (!table || !profileId || !ruleCode || !sourceUpdatedAt) redirect("/people/exceptions?error=Exception+details+are+missing");

  const payload: Record<string, string | null> = { updated_at: new Date().toISOString() };
  for (const field of EDITABLE_FIELDS) {
    if (!formData.has(field)) continue;
    const fieldValue = value(formData.get(field));
    payload[field] = fieldValue || null;
  }
  if (Object.keys(payload).length === 1) redirect("/people/exceptions?error=No+editable+details+were+submitted");

  let update = supabaseAdmin.from(table).update(payload).eq("company_id", companyId).eq("id", profileId).eq(profileType === "employee" ? "profile_completion_status" : "onboarding_status", "active");
  if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner) update = update.in("location_id", authorization.locationScopeIds);
  const { data, error: updateError } = await update.select("updated_at").maybeSingle();
  if (updateError || !data) redirect(`/people/exceptions?error=${encodeURIComponent(updateError?.message ?? "Active profile was not found")}`);

  const { error } = await supabaseAdmin.from("people_exception_resolutions").upsert({
    company_id: companyId, profile_type: profileType, profile_id: profileId, rule_code: ruleCode,
    source_updated_at: sourceUpdatedAt, cleared_by: authorization.userId, cleared_at: new Date().toISOString(),
    remarks: "Profile corrected from People Exceptions"
  }, { onConflict: "company_id,profile_type,profile_id,rule_code" });
  if (error) redirect(`/people/exceptions?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/people/exceptions");
  redirect("/people/exceptions?notice=Profile+updated+and+exception+cleared");
}
