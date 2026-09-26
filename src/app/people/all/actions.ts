"use server";

import { revalidatePath } from "next/cache";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, normalizeWorkforceCategoryCode, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { buildAllPeopleSheetPatch } from "@/lib/all-people-sheet";
import type { AllPeopleExportKey } from "@/lib/all-people-export";
import { syncBiometricEnrolment } from "@/lib/biometric/enrolments";
import { saveProfileVerification } from "@/lib/profile-verifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";

type SheetChanges = Partial<Record<AllPeopleExportKey, string>>;
type SheetSource = { categoryCode: string; designationStorage: "id" | "name"; employeeColumns: boolean; pageCode: string; table: string };
type DesignationRow = { id: string; code: string | null; name: string; onboarding_categories: string[] | null; portal_permissions: unknown };
type BiometricProfile = { profileType: "employee" | "field_executive" | "contractor" | "vendor" | "worker"; workerType: "employee" | "individual_contract" };

const fixedSources: Record<string, Omit<SheetSource, "categoryCode">> = {
  employees: { table: "employees", pageCode: "employees", employeeColumns: true, designationStorage: "id" },
  contractors: { table: "contractors", pageCode: "contractors", employeeColumns: false, designationStorage: "name" },
  vendors: { table: "vendors", pageCode: "vendors", employeeColumns: false, designationStorage: "name" },
  workers: { table: "helpers", pageCode: "workers", employeeColumns: false, designationStorage: "name" },
  workforce: { table: "workforce", pageCode: "delivery_associates", employeeColumns: false, designationStorage: "id" }
};

const biometricProfiles: Record<string, BiometricProfile> = {
  employees: { profileType: "employee", workerType: "employee" },
  workforce: { profileType: "field_executive", workerType: "individual_contract" },
  contractors: { profileType: "contractor", workerType: "individual_contract" },
  vendors: { profileType: "vendor", workerType: "individual_contract" },
  workers: { profileType: "worker", workerType: "individual_contract" }
};

const verificationProfileTypes: Partial<Record<string, WorkforceProfileType>> = {
  employees: "employee",
  workforce: "field_executive",
  contractors: "contractor",
  vendors: "vendor",
  workers: "worker"
};

type VerificationKind = "pan" | "pan_aadhaar" | "dl" | "vehicle" | "bank" | "pf_uan";

function verificationDateKey(value: unknown) {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return (iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : raw.replace(/\//g, "-")).toUpperCase();
}

function verificationInputKey(kind: VerificationKind, source: SheetSource, existing: Record<string, unknown>, payload: Record<string, unknown>) {
  const value = (column: string) => String(Object.prototype.hasOwnProperty.call(payload, column) ? payload[column] ?? "" : existing[column] ?? "").trim().toUpperCase();
  if (kind === "pan") return value("pan_number");
  if (kind === "pan_aadhaar") return `${value("pan_number")}|${value("aadhaar_number")}`;
  if (kind === "dl") return `${value("driving_license_no")}|${verificationDateKey(Object.prototype.hasOwnProperty.call(payload, "date_of_birth") ? payload.date_of_birth : existing.date_of_birth)}`;
  if (kind === "vehicle") return value("vehicle_reg_no");
  if (kind === "pf_uan") return value("pf_uan");
  return `${value("bank_account_no")}|${value(source.employeeColumns ? "ifsc" : "ifsc_code")}`;
}

function failure(error: string, code = "VALIDATION_ERROR") { return { ok: false as const, error, code }; }
function identity(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
function matchesCategory(row: DesignationRow, code: string) { return (row.onboarding_categories ?? []).includes(code); }
function sameValue(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify((Array.isArray(left) ? left : []).map(String).sort()) === JSON.stringify((Array.isArray(right) ? right : []).map(String).sort());
  }
  return String(left ?? "") === String(right ?? "");
}
function sameTimestamp(left: unknown, right: unknown) {
  const a = Date.parse(String(left ?? "")); const b = Date.parse(String(right ?? ""));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
function findDesignation(rows: DesignationRow[], value: unknown) {
  const key = identity(value);
  if (!key) return null;
  const matches = rows.filter((row) => [row.id, row.name, row.code].some((item) => identity(item) === key));
  return matches.length === 1 ? matches[0] : null;
}

async function resolveSource(companyId: string, rawCode: string): Promise<SheetSource | null> {
  const categoryCode = normalizeWorkforceCategoryCode(rawCode);
  if (!categoryCode || !supabaseAdmin) return null;
  const fixed = fixedSources[categoryCode];
  const source = fixed ? { ...fixed, categoryCode } : isCustomWorkforceCategoryCode(categoryCode) ? {
    categoryCode, designationStorage: "name" as const, employeeColumns: false,
    pageCode: workforceCategoryPageCode(categoryCode), table: dynamicWorkforceTable(categoryCode)
  } : null;
  if (!source) return null;
  const category = await supabaseAdmin.from("workforce_categories").select("code")
    .eq("company_id", companyId).eq("code", categoryCode).eq("is_active", true).maybeSingle();
  return category.error || !category.data ? null : source;
}

export async function saveAllPeopleSheetRow({ categoryCode, id, changes, expectedUpdatedAt }: {
  categoryCode: string; id: string; changes: SheetChanges; expectedUpdatedAt: string;
}) {
  const authorization = await getAuthorization();
  if (!authorization) return failure("Your session has expired.", "UNAUTHORIZED");
  if (!supabaseAdmin) return failure("Profile storage is not configured.", "STORAGE_UNAVAILABLE");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id ?? ""))) return failure("Profile identifier is invalid.");
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) return failure("This row is missing its update version. Refresh the page and try again.", "CONFLICT");

  const companyId = requireCompanyId(authorization);
  const source = await resolveSource(companyId, categoryCode);
  if (!source || !hasPermission(authorization, source.pageCode, "edit")) return failure("You do not have permission to edit this profile.", "FORBIDDEN");

  let patch;
  try {
    patch = buildAllPeopleSheetPatch(changes, {
      employeeColumns: source.employeeColumns,
      mobileDigits: source.categoryCode === "employees" ? { min: 6, max: 15 } : { min: 10, max: 10 }
    });
  } catch (error) { return failure(error instanceof Error ? error.message : "The requested changes are invalid."); }

  const current = await supabaseAdmin.from(source.table).select("*").eq("company_id", companyId).eq("id", id).maybeSingle();
  if (current.error || !current.data) return failure(current.error?.message ?? "Profile was not found.", "NOT_FOUND");
  const existing = current.data as Record<string, unknown>;
  if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(String(existing.location_id ?? ""))) return failure("You do not have access to this profile location.", "FORBIDDEN");
  if (!sameTimestamp(existing.updated_at, expectedUpdatedAt)) return failure("This row was updated by someone else. Refresh it before saving your changes.", "CONFLICT");

  const master = await supabaseAdmin.from("designations").select("id, code, name, onboarding_categories, portal_permissions")
    .eq("company_id", companyId).eq("is_active", true);
  if (master.error) return failure(master.error.message);
  const designations = (master.data ?? []) as DesignationRow[];
  const currentDesignation = findDesignation(designations, source.designationStorage === "id" ? existing.designation_id : existing.designation);
  if (isCustomWorkforceCategoryCode(source.categoryCode) && (!currentDesignation || !matchesCategory(currentDesignation, source.categoryCode))) {
    return failure("Profile was not found in the requested category.", "NOT_FOUND");
  }
  const owner = isCompanyOwner(authorization);
  if (!canAccessDesignationPortal(currentDesignation, "dashboard", "edit", { isOwner: owner })) return failure("You do not have permission to edit this profile designation.", "FORBIDDEN");

  const payload = { ...patch.payload };
  if (patch.deferred.location !== undefined) {
    const location = await supabaseAdmin.from("stations").select("id, station_code").eq("company_id", companyId)
      .eq("station_code", patch.deferred.location).eq("is_active", true).maybeSingle();
    if (location.error) return failure(location.error.message);
    if (!location.data) return failure("Selected location is not available for this company.");
    const locationId = String(location.data.id);
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) return failure("You do not have access to the selected location.", "FORBIDDEN");
    payload.location_id = locationId;
  }
  if (patch.deferred.designation !== undefined) {
    const next = findDesignation(designations, patch.deferred.designation);
    if (!next || !matchesCategory(next, source.categoryCode)) return failure("Selected designation is not available for this category.");
    if (!canAccessDesignationPortal(next, "dashboard", "edit", { isOwner: owner })) return failure("You do not have permission to assign the selected designation.", "FORBIDDEN");
    payload[source.designationStorage === "id" ? "designation_id" : "designation"] = source.designationStorage === "id" ? next.id : next.name;
    if (source.categoryCode === "workforce") payload.designation = next.name;
  }

  if (source.categoryCode === "employees" && existing.org_position_id) {
    const position = await supabaseAdmin.from("org_positions")
      .select("id, designation_id, location_access_mode, location_scope_ids, is_active")
      .eq("company_id", companyId).eq("id", existing.org_position_id).maybeSingle();
    if (position.error) return failure(position.error.message);
    if (!position.data?.is_active) return failure("The employee's portal position is not active. Update it from Positions & Delegation first.");
    const nextDesignationId = String(payload.designation_id ?? existing.designation_id ?? "");
    const nextLocationId = String(payload.location_id ?? existing.location_id ?? "");
    if (position.data.designation_id && position.data.designation_id !== nextDesignationId) {
      return failure("The selected designation does not match this employee's portal position. Update the position assignment first.");
    }
    if (position.data.location_access_mode !== "all_locations" && !(position.data.location_scope_ids ?? []).includes(nextLocationId)) {
      return failure("The selected location is outside this employee's portal position scope. Update the position assignment first.");
    }
    if ("email" in payload && !payload.email) return failure("Email is required while this employee has a portal position.");
  }
  if (source.categoryCode === "workforce" && existing.deleted_at && payload.is_active === true) {
    return failure("Archived workforce profiles cannot be reactivated from the sheet.");
  }

  for (const [column, value] of Object.entries(payload)) if (sameValue(existing[column], value)) delete payload[column];
  if (!Object.keys(payload).length) return {
    ok: true as const,
    updatedAt: String(existing.updated_at),
    changedKeys: [] as AllPeopleExportKey[],
    savedValues: patch.canonicalValues
  };

  const nextUpdatedAt = new Date().toISOString();
  const verificationKinds: VerificationKind[] = [];
  if ("pan_number" in payload) verificationKinds.push("pan", "pan_aadhaar");
  if ("aadhaar_number" in payload) verificationKinds.push("pan_aadhaar");
  if ("driving_license_no" in payload || "date_of_birth" in payload) verificationKinds.push("dl");
  if ("vehicle_reg_no" in payload) verificationKinds.push("vehicle");
  if ("bank_account_no" in payload || (source.employeeColumns ? "ifsc" : "ifsc_code") in payload) verificationKinds.push("bank");
  if ("pf_uan" in payload) verificationKinds.push("pf_uan");
  if ("full_name" in payload) verificationKinds.push("pan", "dl", "pf_uan");
  const uniqueVerificationKinds = [...new Set(verificationKinds)];
  const verificationProfileType = verificationProfileTypes[source.categoryCode];
  if (uniqueVerificationKinds.length && verificationProfileType) {
    try {
      const storedProfileTypes = verificationProfileType === "field_executive" ? ["workforce", "field_executive"] : [verificationProfileType];
      const stored = await supabaseAdmin.from("connect_profile_verifications")
        .select("kind, input_key, details")
        .eq("company_id", companyId)
        .eq("account_id", id)
        .in("profile_type", storedProfileTypes)
        .in("kind", uniqueVerificationKinds);
      if (stored.error) throw new Error(stored.error.message);
      const effectiveFullName = identity(payload.full_name ?? existing.full_name);
      const nameSensitiveKinds = new Set<VerificationKind>(["pan", "dl", "pf_uan"]);
      const matchingKinds = new Set((stored.data ?? []).flatMap((item) => {
        const kind = String(item.kind ?? "") as VerificationKind;
        const details = item.details && typeof item.details === "object" ? item.details as Record<string, unknown> : {};
        const nameMatches = !("full_name" in payload) || !nameSensitiveKinds.has(kind)
          || (Boolean(identity(details.registeredName)) && identity(details.registeredName) === effectiveFullName);
        return nameMatches && String(item.input_key ?? "").trim().toUpperCase() === verificationInputKey(kind, source, existing, payload) ? [kind] : [];
      }));
      const kindsToInvalidate = uniqueVerificationKinds.filter((kind) => !matchingKinds.has(kind));
      if (kindsToInvalidate.length) {
        const invalidate = await supabaseAdmin.from("connect_profile_verifications").update({
          verified: false,
          manual_review: false,
          block_submit: true,
          verified_at: null,
          details: { invalidated: true, reason: "profile_field_update" },
          message: "Reverification required after profile field update.",
          updated_at: nextUpdatedAt
        }).eq("company_id", companyId).eq("account_id", id).in("profile_type", storedProfileTypes).in("kind", kindsToInvalidate);
        if (invalidate.error) throw new Error(invalidate.error.message);
      }

      for (const kind of kindsToInvalidate) {
        const inputKey = verificationInputKey(kind, source, existing, payload);
        if (!inputKey.replace(/\|/g, "")) continue;
        await saveProfileVerification({
          accountId: id,
          companyId,
          kind,
          profileType: verificationProfileType,
          result: {
            inputKey,
            verified: false,
            manualReview: false,
            blockSubmit: true,
            message: "Reverification required after profile field update."
          }
        });
      }
    } catch (error) {
      return failure(`Verification status could not be updated, so the profile was not saved: ${error instanceof Error ? error.message : "unknown error"}`, "VERIFICATION_UPDATE_FAILED");
    }
  }

  const update = await supabaseAdmin.from(source.table).update({ ...payload, updated_at: nextUpdatedAt })
    .eq("company_id", companyId).eq("id", id).eq("updated_at", existing.updated_at).select("updated_at").maybeSingle();
  if (update.error) return failure(update.error.message, "UPDATE_FAILED");
  if (!update.data) return failure("This row was updated by someone else. Refresh it before saving your changes.", "CONFLICT");

  let warning: string | undefined;
  const biometricProfile = biometricProfiles[source.categoryCode];
  if (biometricProfile && ["location_id", "date_of_join", "is_active"].some((column) => column in payload)) {
    try {
      await syncBiometricEnrolment({
        accountId: id,
        companyId,
        createdBy: authorization.userId,
        effectiveFrom: String(payload.date_of_join ?? existing.date_of_join ?? ""),
        employeeId: biometricProfile.profileType === "employee" ? id : undefined,
        enrolmentId: String(existing.biometric_id ?? "") || null,
        fieldExecutiveId: biometricProfile.profileType === "field_executive" ? id : undefined,
        isActive: Boolean(payload.is_active ?? existing.is_active) && !existing.deleted_at,
        locationId: String(payload.location_id ?? existing.location_id ?? ""),
        profileType: biometricProfile.profileType,
        workerType: biometricProfile.workerType
      });
    } catch (error) {
      warning = `Profile saved, but the linked biometric enrolment could not be synchronized: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  revalidatePath("/people/all");
  if (source.categoryCode === "workforce") revalidatePath("/people/workforce");
  return {
    ok: true as const,
    updatedAt: String(update.data.updated_at ?? nextUpdatedAt),
    changedKeys: patch.changedKeys,
    savedValues: patch.canonicalValues,
    warning
  };
}
