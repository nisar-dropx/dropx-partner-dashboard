import type { ReactNode } from "react";
import { bulkImportFieldExecutives, changeContractorLifecycleStatus, createFieldExecutive, reviewFieldExecutiveProfile, updateFieldExecutive } from "@/app/field-executive/actions";
import { AppShell } from "@/components/app-shell";
import { CompensationBulkUpload } from "@/components/compensation-bulk-upload";
import { FieldExecutiveList, type FieldExecutiveListRow } from "@/components/field-executive-list";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { ProfileVerificationPanel } from "@/components/profile-verification-panel";
import { ScopedDesignationFields, type ScopedDesignationOption, type ScopedLocationOption } from "@/components/scoped-designation-fields";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { isCompanyOwner, type AuthorizationContext, requirePagePermission } from "@/lib/authorization";
import { currentAccessSurface, type AccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import {
  filterContractorRegisterRows,
  type ContractorRegisterView
} from "@/lib/contractor-register-visibility";
import { countryCodeOptions } from "@/lib/country-codes";
import { formatDashboardDate } from "@/lib/date-format";
import { canOnboardDesignation } from "@/lib/designation-onboarding-access";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import {
  loadMappedDesignationIds,
  targetRegisterForWorkforceRoute,
  type PhysicalRegisterTable
} from "@/lib/designation-register-routing";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforceCategoryDirectActivate, loadWorkforceCategoryRules, loadWorkforceCategoryStatutoryEnabled } from "@/lib/workforce-category-rules";
import {
  nonEmployeeConfigForRoute,
  type NonEmployeeRoute
} from "@/lib/workforce-profiles";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  location_model_id?: string | null;
  hide_from_location_list?: boolean | null;
  providers?: { name: string } | { name: string }[] | null;
  location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
};

type DesignationRow = {
  id: string;
  code: string;
  name: string;
  model_ids?: string[] | null;
  onboarding_categories?: string[] | null;
  profile_field_rules?: unknown;
  onboarding_role_ids?: string[] | null;
  portal_permissions?: unknown;
  is_active: boolean;
};

type FieldExecutivePageCode = "delivery_associates" | "contractors" | "vendors" | "workers";
type FieldExecutiveRoute = NonEmployeeRoute;
type DesignationCategoryFilter = "field_executives" | "contractors" | "vendors" | "workers";

type ExecutiveRow = {
  id: string;
  dropx_id: string | null;
  full_name: string;
  mobile_country_code?: string | null;
  mobile: string;
  email: string;
  date_of_join: string;
  is_active: boolean;
  onboarding_status?: string | null;
  profile_return_remarks?: string | null;
  statutory_applicability?: string[] | null;
  location_id: string;
  designation: string | null;
  gender: string | null;
  date_of_birth: string | null;
  aadhaar_number: string | null;
  pan_number: string | null;
  eshram_uan: string | null;
  address: string | null;
  postal_pin: string | null;
  landmark: string | null;
  state_code: string | null;
  father_name: string | null;
  blood_group: string | null;
  is_handicapped: boolean | null;
  bank_account_no: string | null;
  ifsc_code: string | null;
  pf_uan?: string | null;
  pf_account_no?: string | null;
  esi_no?: string | null;
  driving_license_no: string | null;
  driving_license_exp_date: string | null;
  vehicle_reg_no: string | null;
  vehicle_reg_exp_date: string | null;
  vehicle_insurance_exp_date: string | null;
  vehicle_pollution_exp_date: string | null;
  biometric_id: string | null;
  emergency_contact_name: string | null;
  emergency_contact_number: string | null;
  emergency_contact_relation: string | null;
  aadhaar_front_path?: string | null;
  aadhaar_back_path?: string | null;
  pan_upload_path?: string | null;
  dl_front_path?: string | null;
  dl_back_path?: string | null;
  profile_photo_path?: string | null;
  upload_urls?: Record<string, string>;
  stations?: {
    station_code: string;
    station_name: string | null;
    providers?: { name: string } | { name: string }[] | null;
    location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
  } | {
    station_code: string;
    station_name: string | null;
    providers?: { name: string } | { name: string }[] | null;
    location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
  }[] | null;
};

type FieldExecutiveAddFormValues = {
  fullName?: string;
  mobileCountryCode?: string;
  mobile?: string;
  email?: string;
  dateOfJoin?: string;
  locationId?: string;
  designation?: string;
};

type ProfileLifecycleStatusRow = {
  status: "active" | "suspended" | "offboarded";
  reason: string | null;
  suspended_from: string | null;
  suspended_until: string | null;
  changed_at: string;
  changed_by: string | null;
  changed_by_name?: string | null;
};

type ProfileLifecycleHistoryRow = {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  effective_from: string;
  effective_until: string | null;
  changed_by: string | null;
  changed_by_name?: string | null;
  created_at: string;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

const stateOptions = [
  { value: "AP", label: "AP", helper: "Andhra Pradesh" },
  { value: "AR", label: "AR", helper: "Arunachal Pradesh" },
  { value: "AS", label: "AS", helper: "Assam" },
  { value: "BR", label: "BR", helper: "Bihar" },
  { value: "CG", label: "CG", helper: "Chhattisgarh" },
  { value: "GA", label: "GA", helper: "Goa" },
  { value: "GJ", label: "GJ", helper: "Gujarat" },
  { value: "HR", label: "HR", helper: "Haryana" },
  { value: "HP", label: "HP", helper: "Himachal Pradesh" },
  { value: "JH", label: "JH", helper: "Jharkhand" },
  { value: "KA", label: "KA", helper: "Karnataka" },
  { value: "KL", label: "KL", helper: "Kerala" },
  { value: "MP", label: "MP", helper: "Madhya Pradesh" },
  { value: "MH", label: "MH", helper: "Maharashtra" },
  { value: "MN", label: "MN", helper: "Manipur" },
  { value: "ML", label: "ML", helper: "Meghalaya" },
  { value: "MZ", label: "MZ", helper: "Mizoram" },
  { value: "NL", label: "NL", helper: "Nagaland" },
  { value: "OD", label: "OD", helper: "Odisha" },
  { value: "PB", label: "PB", helper: "Punjab" },
  { value: "RJ", label: "RJ", helper: "Rajasthan" },
  { value: "SK", label: "SK", helper: "Sikkim" },
  { value: "TN", label: "TN", helper: "Tamil Nadu" },
  { value: "TS", label: "TS", helper: "Telangana" },
  { value: "TR", label: "TR", helper: "Tripura" },
  { value: "UP", label: "UP", helper: "Uttar Pradesh" },
  { value: "UK", label: "UK", helper: "Uttarakhand" },
  { value: "WB", label: "WB", helper: "West Bengal" },
  { value: "AN", label: "AN", helper: "Andaman and Nicobar Islands" },
  { value: "CH", label: "CH", helper: "Chandigarh" },
  { value: "DN", label: "DN", helper: "Dadra and Nagar Haveli and Daman and Diu" },
  { value: "DL", label: "DL", helper: "Delhi" },
  { value: "JK", label: "JK", helper: "Jammu and Kashmir" },
  { value: "LA", label: "LA", helper: "Ladakh" },
  { value: "LD", label: "LD", helper: "Lakshadweep" },
  { value: "PY", label: "PY", helper: "Puducherry" }
];

const countryCodeSelectOptions = countryCodeOptions.map((country) => ({
  value: country.code,
  label: `+${country.code}`,
  helper: country.label.replace(/\s*\(\+\d+\)\s*$/, "")
}));

const genderOptions = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
  { value: "Other", label: "Other" }
];

const yesNoOptions = [
  { value: "false", label: "No" },
  { value: "true", label: "Yes" }
];

const statusOptions = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" }
];

function fieldExecutiveStatus(executive: Pick<ExecutiveRow, "is_active" | "onboarding_status">) {
  if (!executive.is_active) return "Inactive";
  if (executive.onboarding_status === "under_review") return "Under review";
  if (executive.onboarding_status === "returned") return "Returned";
  return executive.onboarding_status === "active" ? "Active" : "Pending";
}

function isMissingRelationError(error: unknown, relation: string) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes(relation.toLowerCase()) && (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("could not find")
  );
}

function textValue(value: string | null | undefined) {
  return value ?? "";
}

function displayValue(value: string | boolean | null | undefined) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value || "-";
}

function formatLifecycleDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(date);
}

async function signedDocumentUrl(path: string | null | undefined) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

function ExecutiveDetail({ label, value }: { label: string; value: string | boolean | null | undefined }) {
  return (
    <div className="executive-detail-item">
      <dt>{label}</dt>
      <dd>{displayValue(value)}</dd>
    </div>
  );
}

function UploadDetail({ label, url }: { label: string; url?: string | null }) {
  return (
    <div className="executive-detail-item">
      <dt>{label}</dt>
      <dd>
        {url ? (
          <span className="inline-actions">
            <a className="button secondary compact" href={url} rel="noreferrer" target="_blank">View</a>
            <a className="button secondary compact" download href={url}>Download</a>
          </span>
        ) : "-"}
      </dd>
    </div>
  );
}

function FieldExecutiveDetails({
  dashboardRules,
  executive
}: {
  dashboardRules: { enabled: string[]; required: string[] };
  executive: ExecutiveRow;
}) {
  const location = firstRelation(executive.stations);
  const enabled = new Set(dashboardRules.enabled);
  const hasAny = (...keys: string[]) => keys.some((key) => enabled.has(key));
  return (
    <div className="executive-details">
      <section>
        <h3>Employment</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="ID" value={executive.dropx_id} />
          <ExecutiveDetail label="Full name" value={executive.full_name} />
          <ExecutiveDetail label="Designation" value={executive.designation} />
          <ExecutiveDetail label="Date of join" value={formatDashboardDate(executive.date_of_join)} />
          <ExecutiveDetail label="Location" value={location?.station_name || location?.station_code} />
          <ExecutiveDetail label="Status" value={fieldExecutiveStatus(executive)} />
          <ExecutiveDetail label="Biometric enrolment ID" value={executive.biometric_id} />
        </dl>
      </section>
      <section>
        <h3>Personal and contact</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="Mobile" value={`+${executive.mobile_country_code ?? "91"} ${executive.mobile}`} />
          <ExecutiveDetail label="Email" value={executive.email} />
          {enabled.has("gender") ? <ExecutiveDetail label="Gender" value={executive.gender} /> : null}
          {enabled.has("date_of_birth") ? <ExecutiveDetail label="Date of birth" value={formatDashboardDate(executive.date_of_birth)} /> : null}
          {enabled.has("father_name") ? <ExecutiveDetail label="Father name" value={executive.father_name} /> : null}
          {enabled.has("blood_group") ? <ExecutiveDetail label="Blood group" value={executive.blood_group} /> : null}
          {enabled.has("is_handicapped") ? <ExecutiveDetail label="Handicapped" value={executive.is_handicapped} /> : null}
        </dl>
      </section>
      {hasAny("emergency_contact_number", "emergency_contact_name", "emergency_contact_relation") ? <section>
        <h3>Emergency contact</h3>
        <dl className="executive-detail-grid">
          {enabled.has("emergency_contact_number") ? <ExecutiveDetail label="Contact number" value={executive.emergency_contact_number} /> : null}
          {enabled.has("emergency_contact_name") ? <ExecutiveDetail label="Contact name" value={executive.emergency_contact_name} /> : null}
          {enabled.has("emergency_contact_relation") ? <ExecutiveDetail label="Relation" value={executive.emergency_contact_relation} /> : null}
        </dl>
      </section> : null}
      {hasAny("aadhaar_number", "pan_number", "address", "landmark", "state_code", "pincode") ? <section>
        <h3>Identity and address</h3>
        <dl className="executive-detail-grid">
          {enabled.has("aadhaar_number") ? <ExecutiveDetail label="Aadhaar number" value={executive.aadhaar_number} /> : null}
          {enabled.has("pan_number") ? <ExecutiveDetail label="PAN number" value={executive.pan_number} /> : null}
          {enabled.has("address") ? <ExecutiveDetail label="Address" value={executive.address} /> : null}
          {enabled.has("landmark") ? <ExecutiveDetail label="Landmark" value={executive.landmark} /> : null}
          {enabled.has("state_code") ? <ExecutiveDetail label="State" value={executive.state_code} /> : null}
          {enabled.has("pincode") ? <ExecutiveDetail label="Postal PIN" value={executive.postal_pin} /> : null}
        </dl>
      </section> : null}
      {hasAny("bank_account_no", "ifsc") ? <section>
        <h3>Bank</h3>
        <dl className="executive-detail-grid">
          {enabled.has("bank_account_no") ? <ExecutiveDetail label="Bank account number" value={executive.bank_account_no} /> : null}
          {enabled.has("ifsc") ? <ExecutiveDetail label="IFSC" value={executive.ifsc_code} /> : null}
        </dl>
      </section> : null}
      {hasAny("eshram_uan", "pf_uan", "pf_account_no", "esi_no") ? <section>
        <h3>Statutory</h3>
        <dl className="executive-detail-grid">
          {enabled.has("eshram_uan") ? <ExecutiveDetail label="eShram UAN" value={executive.eshram_uan} /> : null}
          {enabled.has("pf_uan") ? <ExecutiveDetail label="PF UAN" value={executive.pf_uan} /> : null}
          {enabled.has("pf_account_no") ? <ExecutiveDetail label="PF Account No" value={executive.pf_account_no} /> : null}
          {enabled.has("esi_no") ? <ExecutiveDetail label="ESI No" value={executive.esi_no} /> : null}
        </dl>
      </section> : null}
      {hasAny("driving_license_no", "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date", "vehicle_pollution_exp_date") ? <section>
        <h3>License and vehicle</h3>
        <dl className="executive-detail-grid">
          {enabled.has("driving_license_no") ? <ExecutiveDetail label="Driving license number" value={executive.driving_license_no} /> : null}
          {enabled.has("driving_license_exp_date") ? <ExecutiveDetail label="Driving license expiry" value={formatDashboardDate(executive.driving_license_exp_date)} /> : null}
          {enabled.has("vehicle_reg_no") ? <ExecutiveDetail label="Vehicle registration number" value={executive.vehicle_reg_no} /> : null}
          {enabled.has("vehicle_reg_exp_date") ? <ExecutiveDetail label="Vehicle registration expiry" value={formatDashboardDate(executive.vehicle_reg_exp_date)} /> : null}
          {enabled.has("vehicle_insurance_exp_date") ? <ExecutiveDetail label="Vehicle Insurance expiry" value={formatDashboardDate(executive.vehicle_insurance_exp_date)} /> : null}
          {enabled.has("vehicle_pollution_exp_date") ? <ExecutiveDetail label="Pollution expiry" value={formatDashboardDate(executive.vehicle_pollution_exp_date)} /> : null}
        </dl>
      </section> : null}
      {hasAny("aadhaar_front", "aadhaar_back", "pan_upload", "dl_front", "dl_back", "profile_photo") ? <section>
        <h3>Uploads</h3>
        <dl className="executive-detail-grid">
          {enabled.has("aadhaar_front") ? <UploadDetail label="Aadhaar front" url={executive.upload_urls?.aadhaarFront} /> : null}
          {enabled.has("aadhaar_back") ? <UploadDetail label="Aadhaar back" url={executive.upload_urls?.aadhaarBack} /> : null}
          {enabled.has("pan_upload") ? <UploadDetail label="PAN upload" url={executive.upload_urls?.pan} /> : null}
          {enabled.has("dl_front") ? <UploadDetail label="DL front" url={executive.upload_urls?.dlFront} /> : null}
          {enabled.has("dl_back") ? <UploadDetail label="DL back" url={executive.upload_urls?.dlBack} /> : null}
          {enabled.has("profile_photo") ? <UploadDetail label="Profile photo" url={executive.upload_urls?.profilePhoto} /> : null}
        </dl>
      </section> : null}
    </div>
  );
}

function ContractorLifecyclePanel({
  contractor,
  history,
  status
}: {
  contractor: ExecutiveRow;
  history: ProfileLifecycleHistoryRow[];
  status: ProfileLifecycleStatusRow;
}) {
  const suspended = status.status === "suspended";
  const offboarded = status.status === "offboarded";

  return (
    <section className="profile-lifecycle-panel">
      <div className="profile-lifecycle-head">
        <div>
          <span className="profile-review-eyebrow">Profile status</span>
          <h3>{status.status === "active" ? "Active" : status.status === "suspended" ? "Suspended" : "Offboarded"}</h3>
          <p>Status is controlled here and is independent of designation or register routing.</p>
        </div>
        <dl className="profile-lifecycle-summary">
          <div><dt>Last changed</dt><dd>{formatLifecycleDateTime(status.changed_at)}</dd></div>
          <div><dt>Changed by</dt><dd>{status.changed_by_name || "System"}</dd></div>
          {suspended ? <div><dt>Suspended until</dt><dd>{formatLifecycleDateTime(status.suspended_until)}</dd></div> : null}
          {status.reason ? <div><dt>Reason</dt><dd>{status.reason}</dd></div> : null}
        </dl>
      </div>

      {!offboarded ? (
        suspended ? (
          <form action={changeContractorLifecycleStatus} className="profile-lifecycle-form">
            <input name="id" type="hidden" value={contractor.id} />
            <input name="return_path" type="hidden" value="/contractors" />
            <input name="lifecycle_status" type="hidden" value="active" />
            <label className="span-2">Reactivation reason
              <textarea className="field" name="lifecycle_reason" placeholder="Explain why this contractor is being reactivated" required rows={3} />
            </label>
            <SubmitButton
              className="button"
              confirmDescription="The profile will regain active operational access. The reason will be saved in history."
              confirmMessage={`Reactivate ${contractor.full_name}?`}
              confirmSubmitText="Reactivate"
              confirmTitle="Confirm reactivation"
              pendingText="Reactivating..."
            >Reactivate profile</SubmitButton>
          </form>
        ) : (
          <form action={changeContractorLifecycleStatus} className="profile-lifecycle-form">
            <input name="id" type="hidden" value={contractor.id} />
            <input name="return_path" type="hidden" value="/contractors" />
            <input name="lifecycle_status" type="hidden" value="suspended" />
            <label>Suspended until
              <input className="field" name="suspended_until" required type="datetime-local" />
            </label>
            <label className="span-2">Suspension reason
              <textarea className="field" name="lifecycle_reason" placeholder="State the operational or disciplinary reason" required rows={3} />
            </label>
            <SubmitButton
              className="button danger"
              confirmDescription="The profile will remain suspended until the selected time or an authorised user reactivates it."
              confirmMessage={`Suspend ${contractor.full_name}?`}
              confirmSubmitText="Suspend"
              confirmTitle="Confirm suspension"
              pendingText="Suspending..."
            >Suspend profile</SubmitButton>
          </form>
        )
      ) : (
        <div className="message-panel warning">This profile is offboarded. Complete the formal rejoining process before restoring access.</div>
      )}

      <div className="profile-lifecycle-history">
        <h4>Status history</h4>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Changed at</th><th>Change</th><th>Reason</th><th>Period</th><th>Changed by</th></tr></thead>
            <tbody>
              {history.length ? history.map((item) => (
                <tr key={item.id}>
                  <td>{formatLifecycleDateTime(item.created_at)}</td>
                  <td>{item.from_status ? `${item.from_status} → ${item.to_status}` : item.to_status}</td>
                  <td>{item.reason}</td>
                  <td>{item.effective_until ? `${formatLifecycleDateTime(item.effective_from)} – ${formatLifecycleDateTime(item.effective_until)}` : formatLifecycleDateTime(item.effective_from)}</td>
                  <td>{item.changed_by_name || "System"}</td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={5}>No status changes recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function FieldExecutiveForm({
  action,
  executive,
  designationOptions,
  locationOptions,
  mode,
  returnPath,
  submitLabel,
  dashboardRules,
  statutoryEnabled
}: {
  action: (formData: FormData) => Promise<void>;
  executive?: ExecutiveRow | null;
  designationOptions: ScopedDesignationOption[];
  locationOptions: ScopedLocationOption[];
  mode: "create" | "edit";
  returnPath: FieldExecutiveRoute;
  submitLabel?: string;
  dashboardRules: { enabled: string[]; required: string[] };
  statutoryEnabled: boolean;
}) {
  const workforceConfig = nonEmployeeConfigForRoute(returnPath);
  const optionalEditFields = mode === "edit" &&
    (workforceConfig.profileType === "field_executive" || workforceConfig.profileType === "contractor");
  const fieldEnabled = (key: string) => dashboardRules.enabled.includes(key);
  const fieldRequired = (key: string) => !optionalEditFields && dashboardRules.required.includes(key);
  return (
    <form action={action} className="form-grid three">
      <input type="hidden" name="return_path" value={returnPath} />
      {executive ? <input type="hidden" name="id" value={executive.id} /> : null}

      <label>Full name<input className="field" name="full_name" placeholder="Enter full name" required={!optionalEditFields} defaultValue={textValue(executive?.full_name)} /></label>
      <label>Email<input className="field" name="email" placeholder="Enter email" required={!optionalEditFields} type="email" defaultValue={textValue(executive?.email)} /></label>

      <label>Country code
        <select className="select" name="mobile_country_code" defaultValue={executive?.mobile_country_code ?? "91"}>
          {countryCodeOptions.map((country) => (
            <option key={country.code} value={country.code}>{country.label}</option>
          ))}
        </select>
      </label>
      <label>Mobile number<input className="field" inputMode="tel" maxLength={15} name="mobile" pattern="[0-9]{6,15}" placeholder="Enter mobile number" required={!optionalEditFields} defaultValue={textValue(executive?.mobile)} /></label>
      <label>Date of join<input className="field" name="date_of_join" required={!optionalEditFields} type="date" defaultValue={textValue(executive?.date_of_join)} /></label>
      <ScopedDesignationFields
        designationName="designation"
        designationOptions={designationOptions}
        initialDesignation={executive?.designation}
        initialLocationId={executive?.location_id}
        locationName="location_id"
        locationOptions={locationOptions}
        required={!optionalEditFields}
      />
      {statutoryEnabled ? (
        <fieldset className="span-3 statutory-fieldset">
          <legend>Statutory applicability</legend>
          {[
            ["not_applicable", "Not Applicable"],
            ["pf", "PF"],
            ["esi", "ESI"]
          ].map(([value, label]) => (
            <label className="checkbox-line" key={value}>
              <input
                defaultChecked={(executive?.statutory_applicability ?? ["not_applicable"]).includes(value)}
                name="statutory_applicability"
                type="checkbox"
                value={value}
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <label hidden={!fieldEnabled("gender")}>Gender
        <SearchableSelect name="gender" options={genderOptions} defaultValue={executive?.gender} placeholder="Select gender" />
      </label>
      <label hidden={!fieldEnabled("date_of_birth")}>Date of birth<input className="field" name="date_of_birth" required={fieldRequired("date_of_birth")} type="date" defaultValue={textValue(executive?.date_of_birth)} /></label>

      <label hidden={!fieldEnabled("aadhaar_number")}>Aadhaar number<input className="field" inputMode="numeric" maxLength={12} name="aadhaar_number" pattern="[0-9]{12}" placeholder="Enter Aadhaar number" required={fieldRequired("aadhaar_number")} defaultValue={textValue(executive?.aadhaar_number)} /></label>
      <label hidden={!fieldEnabled("pan_number")}>PAN number<input className="field" name="pan_number" placeholder="Enter PAN number" required={fieldRequired("pan_number")} defaultValue={textValue(executive?.pan_number)} />{mode === "edit" && executive ? <ProfileVerificationPanel accountId={executive.id} kind="pan" pageCode={workforceConfig.pageCode} profileType={workforceConfig.profileType} /> : null}</label>
      <label className="span-3" hidden={!fieldEnabled("address")}>Address<input className="field" name="address" placeholder="Enter complete address" required={fieldRequired("address")} defaultValue={textValue(executive?.address)} /></label>
      <label hidden={!fieldEnabled("pincode")}>Postal PIN<input className="field" inputMode="numeric" maxLength={6} name="postal_pin" pattern="[0-9]{6}" placeholder="Enter PIN" required={fieldRequired("pincode")} defaultValue={textValue(executive?.postal_pin)} /></label>
      <label hidden={!fieldEnabled("landmark")}>Land mark<input className="field" name="landmark" placeholder="Enter landmark" required={fieldRequired("landmark")} defaultValue={textValue(executive?.landmark)} /></label>
      <label hidden={!fieldEnabled("state_code")}>State
        <SearchableSelect name="state_code" options={stateOptions} defaultValue={executive?.state_code} placeholder="Search state code" />
      </label>

      <label hidden={!fieldEnabled("father_name")}>Father name<input className="field" name="father_name" placeholder="Enter father name" required={fieldRequired("father_name")} defaultValue={textValue(executive?.father_name)} /></label>
      <label hidden={!fieldEnabled("blood_group")}>Blood group<input className="field" name="blood_group" placeholder="Enter blood group" required={fieldRequired("blood_group")} defaultValue={textValue(executive?.blood_group)} /></label>
      <label hidden={!fieldEnabled("is_handicapped")}>Handicapped
        <SearchableSelect
          name="is_handicapped"
          options={yesNoOptions}
          defaultValue={typeof executive?.is_handicapped === "boolean" ? String(executive.is_handicapped) : undefined}
          placeholder="Select"
        />
      </label>

      <label hidden={!fieldEnabled("bank_account_no")}>Bank A/c No.<input className="field" name="bank_account_no" pattern="[A-Za-z0-9]*" placeholder="Enter bank account number" required={fieldRequired("bank_account_no")} defaultValue={textValue(executive?.bank_account_no)} /></label>
      <label hidden={!fieldEnabled("ifsc")}>IFSC<input className="field" name="ifsc_code" placeholder="Enter IFSC" required={fieldRequired("ifsc")} defaultValue={textValue(executive?.ifsc_code)} />{mode === "edit" && executive ? <ProfileVerificationPanel accountId={executive.id} kind="bank" pageCode={workforceConfig.pageCode} profileType={workforceConfig.profileType} /> : null}</label>
      <label hidden={!fieldEnabled("eshram_uan")}>eShram UAN<input className="field" inputMode="numeric" maxLength={12} name="eshram_uan" pattern="[0-9]{12}" placeholder="Enter eShram UAN" required={fieldRequired("eshram_uan")} defaultValue={textValue(executive?.eshram_uan)} /></label>
      <label hidden={!fieldEnabled("pf_uan")}>PF UAN<input className="field" inputMode="numeric" maxLength={12} name="pf_uan" pattern="[0-9]{12}" placeholder="Enter PF UAN" required={fieldRequired("pf_uan")} defaultValue={textValue(executive?.pf_uan)} />{mode === "edit" && executive ? <ProfileVerificationPanel accountId={executive.id} kind="pf_uan" pageCode={workforceConfig.pageCode} profileType={workforceConfig.profileType} /> : null}</label>
      <label hidden={!fieldEnabled("pf_account_no")}>PF Account No<input className="field" name="pf_account_no" pattern="[A-Za-z0-9]*" placeholder="Enter PF Account No" required={fieldRequired("pf_account_no")} defaultValue={textValue(executive?.pf_account_no)} /></label>
      <label hidden={!fieldEnabled("esi_no")}>ESI No<input className="field" name="esi_no" pattern="[A-Za-z0-9]*" placeholder="Enter ESI No" required={fieldRequired("esi_no")} defaultValue={textValue(executive?.esi_no)} /></label>
      <label hidden={!fieldEnabled("emergency_contact_number")}>Emergency contact number<input className="field" inputMode="numeric" maxLength={10} name="emergency_contact_number" pattern="[0-9]{10}" placeholder="Enter emergency contact number" required={fieldRequired("emergency_contact_number")} defaultValue={textValue(executive?.emergency_contact_number)} /></label>
      <label hidden={!fieldEnabled("emergency_contact_name")}>Emergency contact name<input className="field" name="emergency_contact_name" placeholder="Enter contact person name" required={fieldRequired("emergency_contact_name")} defaultValue={textValue(executive?.emergency_contact_name)} /></label>
      <label hidden={!fieldEnabled("emergency_contact_relation")}>Emergency relation<input className="field" name="emergency_contact_relation" placeholder="Enter relation" required={fieldRequired("emergency_contact_relation")} defaultValue={textValue(executive?.emergency_contact_relation)} /></label>

      <label hidden={!fieldEnabled("driving_license_no")}>Driving license no.<input className="field" name="driving_license_no" placeholder="Enter DL number" required={fieldRequired("driving_license_no")} defaultValue={textValue(executive?.driving_license_no)} />{mode === "edit" && executive ? <ProfileVerificationPanel accountId={executive.id} kind="dl" pageCode={workforceConfig.pageCode} profileType={workforceConfig.profileType} /> : null}</label>
      <label hidden={!fieldEnabled("driving_license_exp_date")}>DL expiry date<input className="field" name="driving_license_exp_date" required={fieldRequired("driving_license_exp_date")} type="date" defaultValue={textValue(executive?.driving_license_exp_date)} /></label>
      <label hidden={!fieldEnabled("vehicle_reg_no")}>Vehicle reg no.<input className="field" name="vehicle_reg_no" placeholder="Enter vehicle number" required={fieldRequired("vehicle_reg_no")} defaultValue={textValue(executive?.vehicle_reg_no)} />{mode === "edit" && executive ? <ProfileVerificationPanel accountId={executive.id} kind="vehicle" pageCode={workforceConfig.pageCode} profileType={workforceConfig.profileType} /> : null}</label>

      <label hidden={!fieldEnabled("vehicle_reg_exp_date")}>Vehicle reg expiry<input className="field" name="vehicle_reg_exp_date" required={fieldRequired("vehicle_reg_exp_date")} type="date" defaultValue={textValue(executive?.vehicle_reg_exp_date)} /></label>
      <label hidden={!fieldEnabled("vehicle_insurance_exp_date")}>Vehicle Insurance expiry<input className="field" name="vehicle_insurance_exp_date" required={fieldRequired("vehicle_insurance_exp_date")} type="date" defaultValue={textValue(executive?.vehicle_insurance_exp_date)} /></label>
      <label hidden={!fieldEnabled("vehicle_pollution_exp_date")}>Pollution expiry<input className="field" name="vehicle_pollution_exp_date" required={fieldRequired("vehicle_pollution_exp_date")} type="date" defaultValue={textValue(executive?.vehicle_pollution_exp_date)} /></label>

      {mode === "edit" ? (
        <>
          <label hidden={!fieldEnabled("aadhaar_front")}>Aadhaar front file<input className="field" name="aadhaar_front_file" type="file" /></label>
          <label hidden={!fieldEnabled("aadhaar_back")}>Aadhaar back file<input className="field" name="aadhaar_back_file" type="file" /></label>
          <label hidden={!fieldEnabled("pan_upload")}>PAN upload<input className="field" name="pan_upload_file" type="file" /></label>
          <label hidden={!fieldEnabled("dl_front")}>DL front file<input className="field" name="dl_front_file" type="file" /></label>
          <label hidden={!fieldEnabled("dl_back")}>DL back file<input className="field" name="dl_back_file" type="file" /></label>
          <label hidden={!fieldEnabled("profile_photo")}>Profile photo<input accept="image/*" className="field" name="profile_photo_file" type="file" /></label>
        </>
      ) : null}

      {mode === "edit" && workforceConfig.profileType !== "contractor" ? (
        <label>Status
          <SearchableSelect name="is_active" options={statusOptions} defaultValue={executive?.is_active ? "true" : "false"} placeholder="Select status" required={!optionalEditFields} />
        </label>
      ) : null}

      <div className="form-actions span-3 align-right">
        <SubmitButton disabled={!locationOptions.length || !designationOptions.length} disabledText={!locationOptions.length ? "Add location first" : "Add designation first"}>
          {mode === "edit" ? "Save changes" : submitLabel ?? "Add field executive"}
        </SubmitButton>
      </div>
    </form>
  );
}

function AddFieldExecutiveForm({
  designationOptions,
  locationOptions,
  entityLabel,
  returnPath,
  values,
  statutoryEnabled
}: {
  designationOptions: ScopedDesignationOption[];
  entityLabel: string;
  locationOptions: ScopedLocationOption[];
  returnPath: FieldExecutiveRoute;
  statutoryEnabled: boolean;
  values?: FieldExecutiveAddFormValues;
}) {
  return (
    <form action={createFieldExecutive} className="form-grid three field-executive-add-form">
      <input type="hidden" name="return_path" value={returnPath} />
      <label>Full name<input className="field" name="full_name" placeholder="Enter full name" required defaultValue={values?.fullName ?? ""} /></label>
      <label className="field-executive-mobile-group">Mobile number
        <div className="field-executive-mobile-row">
          <div className="field-executive-country-code">
            <SearchableSelect name="mobile_country_code" options={countryCodeSelectOptions} defaultValue={values?.mobileCountryCode ?? "91"} placeholder="+91" required />
          </div>
          <input className="field" inputMode="tel" maxLength={15} name="mobile" pattern="[0-9]{6,15}" placeholder="Enter mobile number" required defaultValue={values?.mobile ?? ""} />
        </div>
      </label>
      <label>Email<input className="field" name="email" placeholder="Enter email" required type="email" defaultValue={values?.email ?? ""} /></label>
      <label>Date of join<input className="field" name="date_of_join" required type="date" defaultValue={values?.dateOfJoin ?? ""} /></label>
      <ScopedDesignationFields
        designationName="designation"
        designationOptions={designationOptions}
        initialDesignation={values?.designation}
        initialLocationId={values?.locationId}
        locationName="location_id"
        locationOptions={locationOptions}
      />
      {statutoryEnabled ? (
        <fieldset className="span-3 statutory-fieldset">
          <legend>Statutory applicability</legend>
          {[
            ["not_applicable", "Not Applicable"],
            ["pf", "PF"],
            ["esi", "ESI"]
          ].map(([value, label]) => (
            <label className="checkbox-line" key={value}>
              <input defaultChecked={value === "not_applicable"} name="statutory_applicability" type="checkbox" value={value} />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="span-2 field-executive-location-submit">
        <div className="form-actions align-right field-executive-submit-slot">
          <SubmitButton
            confirmCancelText="No"
            confirmDescription={`Please confirm before creating this ${entityLabel}.`}
            confirmMessage={`Do you want to submit this ${entityLabel} registration?`}
            confirmSubmitText="Yes"
            confirmTitle="Confirm submission"
            disabled={!locationOptions.length || !designationOptions.length}
            disabledText={!locationOptions.length ? "Add location first" : "Add designation first"}
          >Submit</SubmitButton>
        </div>
      </div>
    </form>
  );
}

function FieldExecutiveBulkImportPanel({
  description,
  entityLabel,
  returnPath,
  title
}: {
  description: string;
  entityLabel: string;
  returnPath: FieldExecutiveRoute;
  title: string;
}) {
  return (
    <section className="panel workforce-bulk-panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="subtle">{description}</p>
        </div>
      </div>
      <form action={bulkImportFieldExecutives} className="workforce-bulk-form">
        <input type="hidden" name="return_path" value={returnPath} />
        <div className="workforce-template-note">
          <strong>{entityLabel} upload template</strong>
          <span>Download the prepared Excel, fill one person per row, and upload the completed file.</span>
          <a
            className="template-download-link"
            download
            href={`/api/import-template?kind=${returnPath === "/contractors" ? "contractor" : "field_executive"}`}
          >
            Download sample Excel
          </a>
        </div>
        <input accept=".xlsx,.xls,.csv" className="field" name="bulk_file" required type="file" />
        <SubmitButton
          confirmCancelText="No"
          confirmDescription={`This will create pending ${entityLabel.toLowerCase()} profiles from the uploaded file.`}
          confirmMessage={`Import ${entityLabel.toLowerCase()} records from this file?`}
          confirmSubmitText="Yes"
          confirmTitle="Confirm bulk upload"
        >
          Upload
        </SubmitButton>
      </form>
    </section>
  );
}

async function loadFieldExecutiveData(
  authorization: AuthorizationContext,
  _designationCategoryFilter: DesignationCategoryFilter[],
  table: "field_executives" | "contractors" | "workforce" | "vendors" | "workers",
  targetRegister: PhysicalRegisterTable,
  accessSurface: AccessSurface,
  recordView?: ContractorRegisterView,
  editId?: string,
  viewId?: string
) {
  const ownerAccess = isCompanyOwner(authorization);
  if (!supabaseAdmin) {
    return {
      executives: [] as FieldExecutiveListRow[],
      locations: [] as LocationRow[],
      designations: [] as DesignationRow[],
      editExecutive: null as ExecutiveRow | null,
      viewExecutive: null as ExecutiveRow | null,
      lifecycleStatus: null as ProfileLifecycleStatusRow | null,
      lifecycleHistory: [] as ProfileLifecycleHistoryRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const companyId = requireCompanyId(authorization);
  const mappedDesignationIds = await loadMappedDesignationIds(companyId, targetRegister);
  let locationsResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, location_model_id, hide_from_location_list, providers (name), location_models (code, name)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("station_code");
  if (isMissingColumnError(locationsResult.error)) {
    locationsResult = await supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, location_model_id, providers (name), location_models (code, name)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code");
  }

  let designationsResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
    .from("designations")
    .select("id, code, name, model_ids, onboarding_categories, profile_field_rules, onboarding_role_ids, portal_permissions, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name");
  if (isMissingColumnError(designationsResult.error)) {
    const fallbackDesignationsResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
      .from("designations")
      .select("id, code, name, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name");
    designationsResult = {
      ...fallbackDesignationsResult,
      data: (fallbackDesignationsResult.data ?? []).map((designation) => ({ ...(designation as Record<string, unknown>), model_ids: [], onboarding_categories: ["employees"], profile_field_rules: {}, onboarding_role_ids: [], portal_permissions: null }))
    };
  }

  const executiveSelect = `
        id,
        dropx_id,
        full_name,
        mobile_country_code,
        mobile,
        email,
        date_of_join,
        is_active,
        onboarding_status,
        profile_return_remarks,
        statutory_applicability,
        location_id,
        designation,
        gender,
        date_of_birth,
        aadhaar_number,
        pan_number,
        eshram_uan,
        address,
        postal_pin,
        landmark,
        state_code,
        father_name,
        blood_group,
        is_handicapped,
        bank_account_no,
        ifsc_code,
        pf_uan,
        pf_account_no,
        esi_no,
        driving_license_no,
        driving_license_exp_date,
        vehicle_reg_no,
        vehicle_reg_exp_date,
        vehicle_insurance_exp_date,
        vehicle_pollution_exp_date,
        biometric_id,
        emergency_contact_name,
        emergency_contact_number,
        emergency_contact_relation,
        aadhaar_front_path,
        aadhaar_back_path,
        pan_upload_path,
        dl_front_path,
        dl_back_path,
        profile_photo_path,
        stations (station_code, station_name, providers (name), location_models (code, name))
      `;
  const legacyExecutiveSelect = executiveSelect.replace("mobile_country_code,", "");
  let executivesResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
    .from(table)
    .select(executiveSelect)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (isMissingColumnError(executivesResult.error)) {
    executivesResult = await supabaseAdmin
      .from(table)
      .select(legacyExecutiveSelect)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
  }

  const compatibilityResult = table === "contractors"
    ? await supabaseAdmin
        .from("person_register_links")
        .select("source_profile_id")
        .eq("company_id", companyId)
        .eq("source_register", "contractors")
        .eq("target_register", "workforce")
        .eq("compatibility_active", true)
    : { data: [], error: null };
  const compatibilityError = isMissingRelationError(compatibilityResult.error, "person_register_links")
    ? null
    : compatibilityResult.error;
  const compatibilitySourceIds = new Set(
    (compatibilityResult.data ?? []).map((link) => String(link.source_profile_id))
  );

  const rawLocations = (locationsResult.data ?? []) as unknown as LocationRow[];
  const locations = filterOnboardingLocations(rawLocations, authorization).map((location) => ({
    ...location,
    providers: firstRelation(location.providers),
    location_models: firstRelation(location.location_models)
  })) as LocationRow[];
  const designations = ((designationsResult.data ?? []) as unknown as DesignationRow[])
    .filter((designation) => mappedDesignationIds.has(designation.id));
  const allowedLocationIds = new Set(locations.map((location) => location.id));
  const allowedDesignationNames = new Set(designations
    .filter((designation) => canAccessDesignationPortal(designation, accessSurface, "view", { isOwner: ownerAccess }))
    .map((designation) => designation.name));
  const scopedExecutiveRows = ((executivesResult.data ?? []) as unknown as ExecutiveRow[])
    .filter((executive) => authorization.hasAllLocationAccess || allowedLocationIds.has(executive.location_id))
    .filter((executive) => allowedDesignationNames.has(String(executive.designation ?? "")));
  const visibleExecutiveRows = table === "contractors" && recordView
    ? filterContractorRegisterRows(scopedExecutiveRows, compatibilitySourceIds, recordView)
    : scopedExecutiveRows;
  const executives = visibleExecutiveRows
    .map((executive) => {
    const location = firstRelation(executive.stations);
    const model = firstRelation(location?.location_models);
    return {
      id: executive.id,
      fullName: executive.full_name,
      dropxId: executive.dropx_id ?? "-",
      biometricId: executive.biometric_id ?? "-",
      mobile: `+${executive.mobile_country_code ?? "91"} ${executive.mobile}`,
      email: executive.email,
      location: location?.station_code || "-",
      provider: firstRelation(location?.providers)?.name || "-",
      model: model?.code || model?.name || "-",
      designation: executive.designation || "-",
      canEdit: canAccessDesignationPortal(
        designations.find((designation) => designation.name === executive.designation),
        accessSurface,
          "edit",
          { isOwner: ownerAccess }
      ),
      isActive: executive.is_active,
      status: fieldExecutiveStatus(executive)
    };
  });
  const uploadUrlRows = await Promise.all(visibleExecutiveRows.map(async (executive) => ({
    ...executive,
    upload_urls: {
      aadhaarFront: await signedDocumentUrl(executive.aadhaar_front_path),
      aadhaarBack: await signedDocumentUrl(executive.aadhaar_back_path),
      pan: await signedDocumentUrl(executive.pan_upload_path),
      dlFront: await signedDocumentUrl(executive.dl_front_path),
      dlBack: await signedDocumentUrl(executive.dl_back_path),
      profilePhoto: await signedDocumentUrl(executive.profile_photo_path)
    }
  })));

  const editExecutive = editId
    ? uploadUrlRows
        .find((executive) => executive.id === editId && (authorization.hasAllLocationAccess || allowedLocationIds.has(executive.location_id))) ?? null
    : null;
  const viewExecutive = viewId
    ? uploadUrlRows
        .find((executive) => executive.id === viewId && (authorization.hasAllLocationAccess || allowedLocationIds.has(executive.location_id))) ?? null
    : null;

  const lifecycleProfile = table === "contractors" ? (editExecutive ?? viewExecutive) : null;
  let lifecycleStatus: ProfileLifecycleStatusRow | null = lifecycleProfile
    ? {
        status: lifecycleProfile.is_active ? "active" : "suspended",
        reason: null,
        suspended_from: null,
        suspended_until: null,
        changed_at: new Date().toISOString(),
        changed_by: null,
        changed_by_name: null
      }
    : null;
  let lifecycleHistory: ProfileLifecycleHistoryRow[] = [];

  if (lifecycleProfile) {
    await supabaseAdmin.rpc("reactivate_expired_profile_suspensions");
    const [statusResult, historyResult] = await Promise.all([
      supabaseAdmin
        .from("people_profile_lifecycle_status")
        .select("status,reason,suspended_from,suspended_until,changed_at,changed_by")
        .eq("company_id", companyId)
        .eq("profile_type", "contractor")
        .eq("profile_id", lifecycleProfile.id)
        .maybeSingle(),
      supabaseAdmin
        .from("people_profile_lifecycle_history")
        .select("id,from_status,to_status,reason,effective_from,effective_until,changed_by,created_at")
        .eq("company_id", companyId)
        .eq("profile_type", "contractor")
        .eq("profile_id", lifecycleProfile.id)
        .order("created_at", { ascending: false })
        .limit(50)
    ]);
    if (statusResult.data) lifecycleStatus = statusResult.data as ProfileLifecycleStatusRow;
    lifecycleHistory = (historyResult.data ?? []) as ProfileLifecycleHistoryRow[];

    const actorIds = Array.from(new Set([
      lifecycleStatus?.changed_by,
      ...lifecycleHistory.map((item) => item.changed_by)
    ].filter((value): value is string => Boolean(value))));
    if (actorIds.length) {
      const actorsResult = await supabaseAdmin.from("profiles").select("id,full_name").in("id", actorIds);
      const actorNames = new Map((actorsResult.data ?? []).map((actor) => [String(actor.id), String(actor.full_name ?? "")]));
      if (lifecycleStatus) lifecycleStatus.changed_by_name = lifecycleStatus.changed_by ? actorNames.get(lifecycleStatus.changed_by) ?? null : null;
      lifecycleHistory = lifecycleHistory.map((item) => ({
        ...item,
        changed_by_name: item.changed_by ? actorNames.get(item.changed_by) ?? null : null
      }));
    }
  }

  return {
    executives,
    locations,
    designations,
    editExecutive,
    viewExecutive,
    lifecycleStatus,
    lifecycleHistory,
    error: executivesResult.error?.message || locationsResult.error?.message || designationsResult.error?.message || compatibilityError?.message || null
  };
}

export async function FieldExecutivePageContent({
  activeLabel = "Field Executive",
  addTitle = "Add field executive",
  bulkImportDescription = "Upload existing field executive rows and keep the profile completion pending for the app.",
  bulkImportTitle = "Bulk upload field executives",
  designationCategoryFilter = ["field_executives"],
  detailSubtitle = "Complete Field Executive profile",
  errorMessage,
  editId,
  editTitle = "Edit field executive",
  emptyListLabel = "No field executives added yet.",
  entityLabel = "Field Executive",
  addFormValues,
  listTitle = "Field Executive register",
  notice,
  pageCode = "delivery_associates",
  pageSubtitle = "Register and maintain field executives by location.",
  pageTitle = "Field Executive",
  recordView,
  registerNavigation,
  returnPath = "/field-executive",
  viewId
}: {
  activeLabel?: string;
  addTitle?: string;
  bulkImportDescription?: string;
  bulkImportTitle?: string;
  designationCategoryFilter?: DesignationCategoryFilter[];
  detailSubtitle?: string;
  errorMessage?: string;
  editId?: string;
  editTitle?: string;
  emptyListLabel?: string;
  entityLabel?: string;
  addFormValues?: FieldExecutiveAddFormValues;
  listTitle?: string;
  notice?: string;
  pageCode?: FieldExecutivePageCode;
  pageSubtitle?: string;
  pageTitle?: string;
  recordView?: ContractorRegisterView;
  registerNavigation?: ReactNode;
  returnPath?: FieldExecutiveRoute;
  viewId?: string;
}) {
  const authorization = await requirePagePermission(pageCode, "access");
  const accessSurface = currentAccessSurface();
  const ownerAccess = isCompanyOwner(authorization);
  const permission = authorization.permissions[pageCode] ?? {
    canView: false,
    canAdd: false,
    canEdit: false
  };
  const workforceConfig = nonEmployeeConfigForRoute(returnPath);
  const displayTable = returnPath === "/work-force-register" ? "workforce" : workforceConfig.table;
  const { executives, locations, designations, editExecutive, viewExecutive, lifecycleStatus, lifecycleHistory, error } = await loadFieldExecutiveData(
    authorization,
    designationCategoryFilter,
    displayTable,
    targetRegisterForWorkforceRoute(returnPath),
    accessSurface,
    recordView,
    editId,
    viewId
  );
  const categoryRules = await loadWorkforceCategoryRules(
    requireCompanyId(authorization),
    workforceConfig.designationCategory,
    designations[0]?.profile_field_rules,
    workforceConfig.designationCategory
  );
  const statutoryEnabled = await loadWorkforceCategoryStatutoryEnabled(
    requireCompanyId(authorization),
    workforceConfig.designationCategory,
    false
  );
  const configuredDirectActivate = await loadWorkforceCategoryDirectActivate(
    requireCompanyId(authorization),
    workforceConfig.designationCategory
  );
  const directActivate = workforceConfig.profileType !== "field_executive" && configuredDirectActivate;
  const canMaintainRecordView = recordView !== "compatibility";
  const canAddToRecordView = !recordView || recordView === "active";
  const activeMessage = error ?? errorMessage ?? notice;
  const needsOperationModeMigration = Boolean(activeMessage?.toLowerCase().includes("operation_mode_id"));
  const locationOptions = locations.map((location) => ({
    value: location.id,
    label: location.station_code,
    helper: [firstRelation(location.providers)?.name, firstRelation(location.location_models)?.name || firstRelation(location.location_models)?.code]
      .filter(Boolean)
      .join(" - ") || location.station_name || undefined,
    modelId: location.location_model_id ?? null
  }));
  const designationOptions = await Promise.all(designations.map(async (designation) => ({
    value: designation.name,
    label: designation.name,
    helper: designation.code,
    code: designation.code,
    modelIds: designation.model_ids ?? [],
      canAdd: canAccessDesignationPortal(designation, accessSurface, "add", { isOwner: accessSurface === "dashboard" && ownerAccess }),
      canEdit: canAccessDesignationPortal(designation, accessSurface, "edit", { isOwner: accessSurface === "dashboard" && ownerAccess }),
    dashboardRules: (await loadWorkforceCategoryRules(
      requireCompanyId(authorization),
      workforceConfig.designationCategory,
      designation.profile_field_rules,
      workforceConfig.designationCategory
    )).dashboard
  })));
  const onboardingDesignationOptions = designationOptions.filter((option) => {
    const designation = designations.find((row) => row.name === option.value);
    return designation ? option.canAdd && canOnboardDesignation(designation, authorization) : false;
  });
  const editDesignationOptions = designationOptions.filter((option) => option.canEdit);
  const viewRules = designationOptions.find((option) => option.value === viewExecutive?.designation)?.dashboardRules
    ?? categoryRules.dashboard;
  const editRules = designationOptions.find((option) => option.value === editExecutive?.designation)?.dashboardRules
    ?? categoryRules.dashboard;

  return (
    <AppShell active={activeLabel} pageCode={pageCode}>
      <PageHead
        eyebrow="Workforce master"
        title={pageTitle}
        subtitle={pageSubtitle}
      />

      {registerNavigation}

      {error || errorMessage || notice ? (
        <section className={`panel message-panel ${error || errorMessage ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{error || errorMessage ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {activeMessage}
              {error?.includes("field_executives")
                ? " Run scripts/field_executives_v1.sql in Supabase SQL Editor."
                : ""}
            </p>
            {needsOperationModeMigration ? (
              <pre className="inline-sql">alter table public.field_executives drop column if exists operation_mode_id;</pre>
            ) : null}
          </div>
        </section>
      ) : null}

      {permission.canAdd && canAddToRecordView ? (
        <section className="panel">
          <div className="panel-head"><h2>{addTitle}</h2></div>
          {directActivate ? (
            <FieldExecutiveForm
              action={createFieldExecutive}
              dashboardRules={categoryRules.dashboard}
              designationOptions={onboardingDesignationOptions}
              locationOptions={locationOptions}
              mode="create"
              returnPath={returnPath}
              statutoryEnabled={statutoryEnabled}
              submitLabel="Add and activate"
            />
          ) : (
            <AddFieldExecutiveForm designationOptions={onboardingDesignationOptions} entityLabel={entityLabel} locationOptions={locationOptions} returnPath={returnPath} statutoryEnabled={statutoryEnabled} values={addFormValues} />
          )}
        </section>
      ) : null}

      {permission.canAdd && canAddToRecordView && accessSurface !== "ops" ? <FieldExecutiveBulkImportPanel description={bulkImportDescription} entityLabel={entityLabel} returnPath={returnPath} title={bulkImportTitle} /> : null}
      {ownerAccess && canAddToRecordView && accessSurface !== "ops" && returnPath === "/contractors" ? <CompensationBulkUpload kind="contractor_remuneration" /> : null}

      {permission.canView || permission.canEdit ? <FieldExecutiveList basePath={returnPath} canEdit={permission.canEdit && canMaintainRecordView} emptyLabel={emptyListLabel} rows={executives} title={listTitle} /> : null}

      {(permission.canView || permission.canEdit) && viewExecutive ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="View field executive">
            <div className="panel-head">
              <div>
                <h2>{viewExecutive.full_name}</h2>
                <p className="subtle">{detailSubtitle}</p>
              </div>
              <PendingLink className="icon-button" href={returnPath} scroll={false} aria-label={`Close ${entityLabel.toLowerCase()} details`}>x</PendingLink>
            </div>
            <FieldExecutiveDetails dashboardRules={viewRules} executive={viewExecutive} />
          </section>
        </div>
      ) : null}

      {permission.canEdit && canMaintainRecordView && editExecutive && editDesignationOptions.some((option) => option.value === editExecutive.designation) ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit field executive">
            <div className="panel-head">
              <div>
                <h2>{editTitle}</h2>
                <p className="subtle">Maintain the full registration profile from the Team DropX sample.</p>
              </div>
              <PendingLink className="icon-button" href={returnPath} scroll={false} aria-label={`Close edit ${entityLabel.toLowerCase()}`}>x</PendingLink>
            </div>
            <FieldExecutiveForm
              action={updateFieldExecutive}
              dashboardRules={editRules}
              designationOptions={editDesignationOptions}
              executive={editExecutive}
              locationOptions={locationOptions}
              mode="edit"
              returnPath={returnPath}
              statutoryEnabled={statutoryEnabled}
            />
            {workforceConfig.profileType === "contractor" && lifecycleStatus && editExecutive.onboarding_status === "active" ? (
              <ContractorLifecyclePanel contractor={editExecutive} history={lifecycleHistory} status={lifecycleStatus} />
            ) : null}
            {workforceConfig.profileType !== "field_executive" && editExecutive.onboarding_status === "under_review" ? (
              <section className="profile-review-panel">
                <div className="profile-review-head">
                  <div>
                    <span className="profile-review-eyebrow">Profile decision</span>
                    <h3>{`Review ${entityLabel.toLowerCase()} profile`}</h3>
                    <p>Approve the submitted details or return the profile with clear correction remarks.</p>
                  </div>
                </div>
                <div className="profile-review-options">
                  <div className="profile-review-option profile-review-option-approve">
                    <div>
                      <h4>Approve profile</h4>
                      <p>Confirm the information and activate this profile.</p>
                    </div>
                    <form action={reviewFieldExecutiveProfile} className="profile-review-approve">
                      <input name="id" type="hidden" value={editExecutive.id} />
                      <input name="return_path" type="hidden" value={returnPath} />
                      <input name="review_action" type="hidden" value="approve" />
                      <SubmitButton className="button profile-review-approve-button" pendingText="Approving...">Approve profile</SubmitButton>
                    </form>
                  </div>
                  <div className="profile-review-option profile-review-option-return">
                    <div>
                      <h4>Return for correction</h4>
                      <p>The profile holder will see these remarks before resubmitting.</p>
                    </div>
                    <form action={reviewFieldExecutiveProfile} className="profile-review-return">
                      <input name="id" type="hidden" value={editExecutive.id} />
                      <input name="return_path" type="hidden" value={returnPath} />
                      <input name="review_action" type="hidden" value="return" />
                      <label>
                        <span>Return remarks <strong aria-hidden="true">*</strong></span>
                        <textarea className="field" name="return_remarks" placeholder="Describe what needs to be corrected" required rows={3} />
                      </label>
                      <div className="profile-review-return-actions">
                        <SubmitButton className="button profile-review-return-button" pendingText="Returning...">Return profile</SubmitButton>
                      </div>
                    </form>
                  </div>
                </div>
              </section>
            ) : null}
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
