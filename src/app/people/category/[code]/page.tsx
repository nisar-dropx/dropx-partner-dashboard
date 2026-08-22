import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createDynamicWorkforceProfile, updateDynamicWorkforceProfile } from "@/app/people/category/[code]/actions";
import { AppShell } from "@/components/app-shell";
import { FieldExecutiveList, type FieldExecutiveListRow } from "@/components/field-executive-list";
import { PageHead } from "@/components/page-head";
import { ScopedDesignationFields } from "@/components/scoped-designation-fields";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { PendingLink } from "@/components/pending-link";
import { DirectActivationProfileFields } from "@/components/direct-activation-profile-fields";
import { normalizeCategoryProfileFieldRules } from "@/lib/profile-field-rules";
import { workforceProfileFields } from "@/lib/profile-field-rules";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { currentAccessSurface, type AccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { countryCodeOptions } from "@/lib/country-codes";
import { formatDashboardDate } from "@/lib/date-format";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, normalizeWorkforceCategoryCode, singularCategoryLabel, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canOnboardDesignation } from "@/lib/designation-onboarding-access";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";

type CategoryRow = {
  code: string;
  name: string;
  statutory_enabled: boolean;
  direct_activate: boolean;
  profile_field_rules: unknown;
};

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  location_model_id: string | null;
  hide_from_location_list?: boolean | null;
  providers?: { name?: string } | Array<{ name?: string }> | null;
  location_models?: { code?: string; name?: string } | Array<{ code?: string; name?: string }> | null;
};

type DesignationRow = {
  id: string;
  code: string;
  name: string;
  model_ids: string[] | null;
  onboarding_categories: string[] | null;
  onboarding_role_ids?: string[] | null;
  portal_permissions?: unknown;
};

type ProfileRow = {
  id: string;
  dropx_id: string | null;
  biometric_id: string | null;
  full_name: string;
  mobile_country_code: string | null;
  mobile: string;
  email: string;
  date_of_join: string | null;
  location_id: string;
  designation: string | null;
  is_active: boolean;
  onboarding_status: string | null;
  profile_photo_path?: string | null;
  statutory_applicability?: string[] | null;
  gender?: string | null;
  date_of_birth?: string | null;
  aadhaar_number?: string | null;
  pan_number?: string | null;
  eshram_uan?: string | null;
  father_name?: string | null;
  blood_group?: string | null;
  is_handicapped?: boolean | null;
  address?: string | null;
  state_code?: string | null;
  postal_pin?: string | null;
  landmark?: string | null;
  bank_account_no?: string | null;
  ifsc_code?: string | null;
  pf_uan?: string | null;
  pf_account_no?: string | null;
  esi_no?: string | null;
  driving_license_no?: string | null;
  driving_license_exp_date?: string | null;
  vehicle_reg_no?: string | null;
  vehicle_reg_exp_date?: string | null;
  vehicle_insurance_exp_date?: string | null;
  vehicle_pollution_exp_date?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_number?: string | null;
  emergency_contact_relation?: string | null;
  aadhaar_front_path?: string | null;
  aadhaar_back_path?: string | null;
  pan_upload_path?: string | null;
  dl_front_path?: string | null;
  dl_back_path?: string | null;
  stations?: LocationRow | LocationRow[] | null;
};

const fieldColumnNames: Record<string, keyof ProfileRow> = { pincode: "postal_pin", ifsc: "ifsc_code" };
const uploadColumns: Record<string, keyof ProfileRow> = {
  aadhaar_front: "aadhaar_front_path", aadhaar_back: "aadhaar_back_path", pan_upload: "pan_upload_path",
  dl_front: "dl_front_path", dl_back: "dl_back_path", profile_photo: "profile_photo_path"
};

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function statusLabel(row: Pick<ProfileRow, "is_active" | "onboarding_status">) {
  if (!row.is_active) return "Inactive";
  const value = String(row.onboarding_status ?? "pending").replaceAll("_", " ");
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const countryOptions = countryCodeOptions.map((country) => ({
  value: country.code,
  label: `+${country.code}`,
  helper: country.label.replace(/\s*\(\+\d+\)\s*$/, "")
}));

export const dynamic = "force-dynamic";

export async function DynamicWorkforceCategoryPageContent({
  params,
  searchParams,
  pageCodeOverride,
  returnPathOverride,
  registerNavigation
}: {
  params: { code: string };
  searchParams?: Record<string, string | undefined>;
  pageCodeOverride?: string;
  returnPathOverride?: string;
  registerNavigation?: ReactNode;
}) {
  const code = normalizeWorkforceCategoryCode(params.code);
  if (!isCustomWorkforceCategoryCode(code)) notFound();
  const pageCode = pageCodeOverride ?? workforceCategoryPageCode(code);
  const returnPath = returnPathOverride ?? `/people/category/${code}`;
  const accessSurface: AccessSurface = currentAccessSurface();
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, pageCode, "access")) redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}&action=access`);
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const categoryResult = await supabaseAdmin
    .from("workforce_categories")
    .select("code, name, statutory_enabled, direct_activate, profile_field_rules")
    .eq("company_id", companyId)
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if (categoryResult.error || !categoryResult.data) notFound();
  const category = categoryResult.data as CategoryRow;
  const provisionResult = await supabaseAdmin.rpc("provision_workforce_category_table", {
    p_category_code: code,
    p_company_id: companyId
  });

  const [locationsResult, designationsResult] = await Promise.all([
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, location_model_id, hide_from_location_list, providers (name), location_models (code, name)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code"),
    supabaseAdmin
      .from("designations")
      .select("id, code, name, model_ids, onboarding_categories, onboarding_role_ids, portal_permissions")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
  ]);
  const profileResult = provisionResult.error
    ? { data: [] as ProfileRow[], error: provisionResult.error }
    : await supabaseAdmin
      .from(dynamicWorkforceTable(code))
      .select("*, stations (station_code, station_name, providers (name), location_models (code, name))")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

  const rawLocations = (locationsResult.data ?? []) as unknown as LocationRow[];
  const locations = filterOnboardingLocations(rawLocations, authorization);
  const ownerAccess = authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const designations = ((designationsResult.data ?? []) as unknown as DesignationRow[])
    .filter((designation) => (designation.onboarding_categories ?? []).includes(code))
    .filter((designation) => canAccessDesignationPortal(designation, accessSurface, "view", { isOwner: accessSurface === "dashboard" && ownerAccess }));
  const locationOptions = locations.map((location) => ({
    value: location.id,
    label: location.station_code,
    helper: first(location.providers)?.name || location.station_name || undefined,
    modelId: location.location_model_id
  }));
  const designationOptions = designations
    .filter((designation) => canAccessDesignationPortal(designation, accessSurface, "add", { isOwner: accessSurface === "dashboard" && ownerAccess }))
    .filter((designation) => canOnboardDesignation(designation, authorization))
    .map((designation) => ({
    value: designation.name,
    label: designation.name,
    helper: designation.code,
    modelIds: designation.model_ids ?? []
  }));
  const rows: FieldExecutiveListRow[] = ((profileResult.data ?? []) as unknown as ProfileRow[])
    .filter((profile) => authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(profile.location_id))
    .map((profile) => {
      const location = first(profile.stations);
      const model = first(location?.location_models);
      return {
        id: profile.id,
        dropxId: profile.dropx_id ?? "-",
        biometricId: profile.biometric_id ?? "-",
        fullName: profile.full_name,
        mobile: `+${profile.mobile_country_code ?? "91"} ${profile.mobile}`,
        email: profile.email,
        location: location?.station_code ?? "-",
        provider: first(location?.providers)?.name ?? "-",
        model: model?.code ?? model?.name ?? "-",
        designation: profile.designation ?? "-",
        isActive: profile.is_active,
        status: statusLabel(profile)
      };
    });
  const profiles = (profileResult.data ?? []) as unknown as ProfileRow[];
  const selectedProfile = profiles.find((profile) => (
    profile.id === (searchParams?.view ?? searchParams?.edit) &&
    (authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(profile.location_id))
  )) ?? null;
  const dashboardRules = normalizeCategoryProfileFieldRules(category.profile_field_rules).dashboard;
  const enabledFields = workforceProfileFields.filter((field) => dashboardRules.enabled.includes(field.key));
  const canEdit = hasPermission(authorization, pageCode, "edit");
  const entityLabel = singularCategoryLabel(category.name);
  const error = searchParams?.error ?? provisionResult.error?.message ?? locationsResult.error?.message ?? designationsResult.error?.message ?? profileResult.error?.message;

  return (
    <AppShell active={category.name} pageCode={pageCode}>
      <PageHead eyebrow="Workforce master" title={category.name} subtitle={`Register and maintain ${category.name.toLowerCase()} by location.`} />
      {registerNavigation}
      {error || searchParams?.notice ? (
        <section className={`panel message-panel ${error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error ?? searchParams?.notice}
              {provisionResult.error ? " Run scripts/workforce_dynamic_category_tables_v1.sql in Supabase SQL Editor, then refresh." : ""}
            </p>
          </div>
        </section>
      ) : null}

      {hasPermission(authorization, pageCode, "add") ? (
        <section className="panel">
          <div className="panel-head"><h2>{`Add ${entityLabel.toLowerCase()}`}</h2></div>
          <form action={createDynamicWorkforceProfile} className="form-grid three field-executive-add-form">
            <input name="category_code" type="hidden" value={code} />
            <input name="return_path" type="hidden" value={returnPath} />
            <label>Full name<input className="field" defaultValue={searchParams?.full_name ?? ""} name="full_name" placeholder="Enter full name" required /></label>
            <label className="field-executive-mobile-group">Mobile number
              <div className="field-executive-mobile-row">
                <div className="field-executive-country-code">
                  <SearchableSelect name="mobile_country_code" options={countryOptions} placeholder="+91" required value={searchParams?.mobile_country_code ?? "91"} />
                </div>
                <input className="field" defaultValue={searchParams?.mobile ?? ""} inputMode="numeric" name="mobile" placeholder="Enter mobile number" required />
              </div>
            </label>
            <label>Email<input className="field" defaultValue={searchParams?.email ?? ""} name="email" placeholder="Enter email" required type="email" /></label>
            <label>Date of join<input className="field" defaultValue={searchParams?.date_of_join ?? ""} name="date_of_join" required type="date" /></label>
            <ScopedDesignationFields
              designationName="designation"
              designationOptions={designationOptions}
              initialDesignation={searchParams?.designation}
              initialLocationId={searchParams?.location_id}
              locationName="location_id"
              locationOptions={locationOptions}
            />
            {category.statutory_enabled ? (
              <fieldset className="statutory-fieldset">
                <legend>Statutory applicability</legend>
                <label className="check-option"><input defaultChecked name="statutory_applicability" type="checkbox" value="not_applicable" /> Not Applicable</label>
                <label className="check-option"><input name="statutory_applicability" type="checkbox" value="pf" /> PF</label>
                <label className="check-option"><input name="statutory_applicability" type="checkbox" value="esi" /> ESI</label>
              </fieldset>
            ) : null}
            {category.direct_activate ? <DirectActivationProfileFields rules={normalizeCategoryProfileFieldRules(category.profile_field_rules).dashboard} /> : null}
            <div className="form-actions align-right field-executive-submit-slot dynamic-workforce-submit-slot">
              <SubmitButton disabled={Boolean(provisionResult.error) || !locationOptions.length || !designationOptions.length} disabledText={provisionResult.error ? "Database setup required" : !locationOptions.length ? "Add location first" : "Add designation first"}>
                {category.direct_activate ? "Add and activate" : "Add profile"}
              </SubmitButton>
            </div>
          </form>
        </section>
      ) : null}

      <FieldExecutiveList basePath={returnPath} canEdit={canEdit} emptyLabel={`No ${category.name.toLowerCase()} added yet.`} rows={rows} title={`${category.name} register`} />

      {searchParams?.view && selectedProfile ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label={`View ${entityLabel.toLowerCase()}`}>
            <div className="panel-head">
              <div><h2>{selectedProfile.full_name}</h2><p className="subtle">Complete {entityLabel.toLowerCase()} profile</p></div>
              <PendingLink className="icon-button" href={returnPath} scroll={false} aria-label="Close profile details">x</PendingLink>
            </div>
            <div className="executive-details">
              <section><h3>Profile</h3><dl className="executive-detail-grid">
                <div className="executive-detail-item"><dt>DropX ID</dt><dd>{displayValue(selectedProfile.dropx_id)}</dd></div>
                <div className="executive-detail-item"><dt>Biometric ID</dt><dd>{displayValue(selectedProfile.biometric_id)}</dd></div>
                <div className="executive-detail-item"><dt>Full name</dt><dd>{displayValue(selectedProfile.full_name)}</dd></div>
                <div className="executive-detail-item"><dt>Mobile</dt><dd>{selectedProfile.mobile ? `+${selectedProfile.mobile_country_code ?? "91"} ${selectedProfile.mobile}` : "-"}</dd></div>
                <div className="executive-detail-item"><dt>Email</dt><dd>{displayValue(selectedProfile.email)}</dd></div>
                <div className="executive-detail-item"><dt>Date of join</dt><dd>{formatDashboardDate(selectedProfile.date_of_join)}</dd></div>
                <div className="executive-detail-item"><dt>Location</dt><dd>{displayValue(first(selectedProfile.stations)?.station_code)}</dd></div>
                <div className="executive-detail-item"><dt>Designation</dt><dd>{displayValue(selectedProfile.designation)}</dd></div>
                <div className="executive-detail-item"><dt>Status</dt><dd>{statusLabel(selectedProfile)}</dd></div>
              </dl></section>
              {Array.from(new Set(enabledFields.map((field) => field.group))).map((group) => (
                <section key={group}><h3>{group}</h3><dl className="executive-detail-grid">
                  {enabledFields.filter((field) => field.group === group).map((field) => {
                    const pathColumn = uploadColumns[field.key];
                    if (pathColumn) return <div className="executive-detail-item" key={field.key}><dt>{field.label}</dt><dd>{selectedProfile[pathColumn] ? <a className="button secondary compact" href={`/api/people/category-document?code=${encodeURIComponent(code)}&id=${encodeURIComponent(selectedProfile.id)}&field=${encodeURIComponent(field.key)}`} target="_blank" rel="noreferrer">View</a> : "-"}</dd></div>;
                    const fieldValue = selectedProfile[fieldColumnNames[field.key] ?? field.key as keyof ProfileRow];
                    return <div className="executive-detail-item" key={field.key}><dt>{field.label}</dt><dd>{field.kind === "date" ? formatDashboardDate(String(fieldValue ?? "")) : displayValue(fieldValue)}</dd></div>;
                  })}
                </dl></section>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {searchParams?.edit && selectedProfile && canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label={`Edit ${entityLabel.toLowerCase()}`}>
            <div className="panel-head">
              <div><h2>Edit {entityLabel.toLowerCase()}</h2><p className="subtle">Maintain the complete registration profile.</p></div>
              <PendingLink className="icon-button" href={returnPath} scroll={false} aria-label="Close profile editor">x</PendingLink>
            </div>
            <form action={updateDynamicWorkforceProfile} className="form-grid three" encType="multipart/form-data">
              <input name="category_code" type="hidden" value={code} /><input name="id" type="hidden" value={selectedProfile.id} />
              <label>Full name<input className="field" defaultValue={selectedProfile.full_name} name="full_name" /></label>
              <label className="field-executive-mobile-group">Mobile number<div className="field-executive-mobile-row"><div className="field-executive-country-code"><SearchableSelect name="mobile_country_code" options={countryOptions} placeholder="+91" value={selectedProfile.mobile_country_code ?? "91"} /></div><input className="field" defaultValue={selectedProfile.mobile} inputMode="numeric" name="mobile" /></div></label>
              <label>Email<input className="field" defaultValue={selectedProfile.email} name="email" type="email" /></label>
              <label>Date of join<input className="field" defaultValue={selectedProfile.date_of_join ?? ""} name="date_of_join" type="date" /></label>
              <ScopedDesignationFields designationName="designation" designationOptions={designationOptions} initialDesignation={selectedProfile.designation ?? undefined} initialLocationId={selectedProfile.location_id} locationName="location_id" locationOptions={locationOptions} required={false} />
              {category.statutory_enabled ? <fieldset className="span-3 statutory-fieldset"><legend>Statutory applicability</legend>{[["not_applicable","Not Applicable"],["pf","PF"],["esi","ESI"]].map(([value,label]) => <label className="checkbox-line" key={value}><input defaultChecked={(selectedProfile.statutory_applicability ?? ["not_applicable"]).includes(value)} name="statutory_applicability" type="checkbox" value={value} />{label}</label>)}</fieldset> : null}
              {enabledFields.map((field) => {
                const name = fieldColumnNames[field.key] ?? field.key;
                const pathColumn = uploadColumns[field.key];
                if (pathColumn) return <label key={field.key}>{field.label}<input className="field" name={`${field.key === "profile_photo" ? "profile_photo" : field.key}_file`} type="file" />{selectedProfile[pathColumn] ? <small>Current file available</small> : null}</label>;
                if (field.key === "gender") return <label key={field.key}>{field.label}<select className="field" defaultValue={selectedProfile.gender ?? ""} name={name}><option value="">Select gender</option><option>Male</option><option>Female</option><option>Other</option></select></label>;
                if (field.key === "is_handicapped") return <label key={field.key}>{field.label}<select className="field" defaultValue={typeof selectedProfile.is_handicapped === "boolean" ? String(selectedProfile.is_handicapped) : ""} name={name}><option value="">Select</option><option value="false">No</option><option value="true">Yes</option></select></label>;
                return <label className={field.key === "address" ? "span-3" : undefined} key={field.key}>{field.label}<input className="field" defaultValue={displayValue(selectedProfile[name as keyof ProfileRow]) === "-" ? "" : String(selectedProfile[name as keyof ProfileRow])} name={name} type={field.kind === "date" ? "date" : "text"} /></label>;
              })}
              <label>Status<select className="field" defaultValue={String(selectedProfile.is_active)} name="is_active"><option value="true">Active</option><option value="false">Inactive</option></select></label>
              <div className="form-actions span-3 align-right"><SubmitButton>Save changes</SubmitButton></div>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}

export default async function DynamicWorkforceCategoryPage(props: {
  params: { code: string };
  searchParams?: Record<string, string | undefined>;
}) {
  return <DynamicWorkforceCategoryPageContent {...props} />;
}
