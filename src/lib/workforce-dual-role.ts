import "server-only";
import type { OnboardingIdentityEvaluation } from "@/lib/onboarding-identity";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Dual role: a People worker (e.g. Station Support Associate, mornings) who
 * also works as a Workforce Delivery Associate (evenings). The two stay
 * separate records - SSA in People, DA in Workforce - but the DA record uses
 * the SAME DropX ID and biometric ID as the People profile. The biometric
 * enrolment stays with the People profile, so machine punches keep feeding the
 * SSA attendance; DA pay comes from deliveries as for any DA.
 */
export type PeopleIdentity = {
  sourceType: "employees" | "contractors";
  sourceId: string;
  dropxId: string | null;
  biometricId: string | null;
  designation: string | null;
};

/** The People profile behind a mobile match, if the new Workforce record is a second role. */
export async function peopleIdentityForDualRole(companyId: string, evaluation: OnboardingIdentityEvaluation): Promise<PeopleIdentity | null> {
  if (!supabaseAdmin) return null;
  const match = [...evaluation.otherMatches].find((item) => item.source_type === "employees" || item.source_type === "contractors");
  if (!match) return null;
  if (match.source_type === "employees") {
    const row = await supabaseAdmin.from("employees").select("employee_code,biometric_id,designations(name)")
      .eq("company_id", companyId).eq("id", match.source_id).is("deleted_at", null).maybeSingle();
    if (row.error) throw new Error(row.error.message);
    if (!row.data) return null;
    const designation = row.data.designations as unknown as { name?: string } | Array<{ name?: string }> | null;
    return {
      sourceType: "employees", sourceId: match.source_id, dropxId: row.data.employee_code ?? null, biometricId: row.data.biometric_id ?? null,
      designation: (Array.isArray(designation) ? designation[0]?.name : designation?.name) ?? match.designation_name ?? null
    };
  }
  const row = await supabaseAdmin.from("contractors").select("dropx_id,biometric_id,designation")
    .eq("company_id", companyId).eq("id", match.source_id).is("deleted_at", null).maybeSingle();
  if (row.error) throw new Error(row.error.message);
  if (!row.data) return null;
  return { sourceType: "contractors", sourceId: match.source_id, dropxId: row.data.dropx_id ?? null, biometricId: row.data.biometric_id ?? null, designation: row.data.designation ?? match.designation_name ?? null };
}

/** True when this biometric ID is already enrolled to a People profile (so the DA must not take it over). */
export async function biometricBelongsToPeople(companyId: string, biometricId: string | null | undefined) {
  const digits = String(biometricId ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!digits || !supabaseAdmin) return false;
  const variants = [...new Set([digits, digits.padStart(6, "0"), digits.padStart(8, "0"), String(biometricId)])];
  const row = await supabaseAdmin.from("biometric_enrolments").select("id")
    .eq("company_id", companyId).in("enrolment_id", variants).eq("status", "Active")
    .or("employee_id.not.is.null,contractor_id.not.is.null").limit(1).maybeSingle();
  if (row.error) throw new Error(row.error.message);
  return Boolean(row.data);
}
