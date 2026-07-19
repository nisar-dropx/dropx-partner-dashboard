import { createFieldExecutive, updateFieldExecutive } from "@/app/field-executive/actions";
import { AppShell } from "@/components/app-shell";
import { FieldExecutiveList, type FieldExecutiveListRow } from "@/components/field-executive-list";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { type AuthorizationContext, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { countryCodeOptions } from "@/lib/country-codes";
import { supabaseAdmin } from "@/lib/supabase-admin";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  hide_from_location_list?: boolean | null;
  providers?: { name: string } | { name: string }[] | null;
  location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
};

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
  location_id: string;
  designation: string | null;
  gender: string | null;
  date_of_birth: string | null;
  aadhaar_number: string | null;
  pan_number: string | null;
  address: string | null;
  postal_pin: string | null;
  landmark: string | null;
  state_code: string | null;
  father_name: string | null;
  blood_group: string | null;
  is_handicapped: boolean | null;
  bank_account_no: string | null;
  ifsc_code: string | null;
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
  dl_front_path?: string | null;
  dl_back_path?: string | null;
  profile_photo_path?: string | null;
  upload_urls?: Record<string, string>;
  stations?: {
    station_code: string;
    station_name: string | null;
    providers?: { name: string } | { name: string }[] | null;
  } | {
    station_code: string;
    station_name: string | null;
    providers?: { name: string } | { name: string }[] | null;
  }[] | null;
};

type FieldExecutiveAddFormValues = {
  fullName?: string;
  mobileCountryCode?: string;
  mobile?: string;
  email?: string;
  dateOfJoin?: string;
  locationId?: string;
  biometricId?: string;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function filterLocationsByAccess<T extends { id: string }>(locations: T[], authorization: AuthorizationContext) {
  if (authorization.hasAllLocationAccess) return locations;

  const allowedIds = new Set(authorization.locationScopeIds);
  return locations.filter((location) => allowedIds.has(location.id) && !(location as { hide_from_location_list?: boolean | null }).hide_from_location_list);
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
  return executive.onboarding_status === "active" ? "Active" : "Pending";
}

function textValue(value: string | null | undefined) {
  return value ?? "";
}

function displayValue(value: string | boolean | null | undefined) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value || "-";
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

function FieldExecutiveDetails({ executive }: { executive: ExecutiveRow }) {
  const location = firstRelation(executive.stations);
  return (
    <div className="executive-details">
      <section>
        <h3>Employment</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="ID" value={executive.dropx_id} />
          <ExecutiveDetail label="Full name" value={executive.full_name} />
          <ExecutiveDetail label="Designation" value={executive.designation} />
          <ExecutiveDetail label="Date of join" value={executive.date_of_join} />
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
          <ExecutiveDetail label="Gender" value={executive.gender} />
          <ExecutiveDetail label="Date of birth" value={executive.date_of_birth} />
          <ExecutiveDetail label="Father name" value={executive.father_name} />
          <ExecutiveDetail label="Blood group" value={executive.blood_group} />
          <ExecutiveDetail label="Handicapped" value={executive.is_handicapped} />
        </dl>
      </section>
      <section>
        <h3>Emergency contact</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="Contact number" value={executive.emergency_contact_number} />
          <ExecutiveDetail label="Contact name" value={executive.emergency_contact_name} />
          <ExecutiveDetail label="Relation" value={executive.emergency_contact_relation} />
        </dl>
      </section>
      <section>
        <h3>Identity and address</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="Aadhaar number" value={executive.aadhaar_number} />
          <ExecutiveDetail label="PAN number" value={executive.pan_number} />
          <ExecutiveDetail label="Address" value={executive.address} />
          <ExecutiveDetail label="Landmark" value={executive.landmark} />
          <ExecutiveDetail label="State" value={executive.state_code} />
          <ExecutiveDetail label="Postal PIN" value={executive.postal_pin} />
        </dl>
      </section>
      <section>
        <h3>Bank</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="Bank account number" value={executive.bank_account_no} />
          <ExecutiveDetail label="IFSC" value={executive.ifsc_code} />
        </dl>
      </section>
      <section>
        <h3>License and vehicle</h3>
        <dl className="executive-detail-grid">
          <ExecutiveDetail label="Driving license number" value={executive.driving_license_no} />
          <ExecutiveDetail label="Driving license expiry" value={executive.driving_license_exp_date} />
          <ExecutiveDetail label="Vehicle registration number" value={executive.vehicle_reg_no} />
          <ExecutiveDetail label="Vehicle registration expiry" value={executive.vehicle_reg_exp_date} />
          <ExecutiveDetail label="Insurance expiry" value={executive.vehicle_insurance_exp_date} />
          <ExecutiveDetail label="Pollution expiry" value={executive.vehicle_pollution_exp_date} />
        </dl>
      </section>
      <section>
        <h3>Uploads</h3>
        <dl className="executive-detail-grid">
          <UploadDetail label="Aadhaar front" url={executive.upload_urls?.aadhaarFront} />
          <UploadDetail label="Aadhaar back" url={executive.upload_urls?.aadhaarBack} />
          <UploadDetail label="DL front" url={executive.upload_urls?.dlFront} />
          <UploadDetail label="DL back" url={executive.upload_urls?.dlBack} />
          <UploadDetail label="Profile photo" url={executive.upload_urls?.profilePhoto} />
        </dl>
      </section>
    </div>
  );
}

function FieldExecutiveForm({
  action,
  executive,
  locationOptions,
  mode
}: {
  action: (formData: FormData) => Promise<void>;
  executive?: ExecutiveRow | null;
  locationOptions: { value: string; label: string; helper?: string }[];
  mode: "create" | "edit";
}) {
  return (
    <form action={action} className="form-grid three">
      {executive ? <input type="hidden" name="id" value={executive.id} /> : null}

      <label>DropX ID<input className="field" value={textValue(executive?.dropx_id)} disabled readOnly /></label>
      <label>Full name<input className="field" name="full_name" placeholder="Enter full name" required defaultValue={textValue(executive?.full_name)} /></label>
      <label>Email<input className="field" name="email" placeholder="Enter email" required type="email" defaultValue={textValue(executive?.email)} /></label>

      <label>Country code
        <select className="select" name="mobile_country_code" defaultValue={executive?.mobile_country_code ?? "91"}>
          {countryCodeOptions.map((country) => (
            <option key={country.code} value={country.code}>{country.label}</option>
          ))}
        </select>
      </label>
      <label>Mobile number<input className="field" inputMode="tel" maxLength={15} name="mobile" pattern="[0-9]{6,15}" placeholder="Enter mobile number" required defaultValue={textValue(executive?.mobile)} /></label>
      <label>Date of join<input className="field" name="date_of_join" required type="date" defaultValue={textValue(executive?.date_of_join)} /></label>
      <label>Location
        <SearchableSelect name="location_id" options={locationOptions} defaultValue={executive?.location_id} placeholder="Select location" required />
      </label>

      <label>Designation<input className="field" name="designation" placeholder="Enter designation" required defaultValue={textValue(executive?.designation)} /></label>
      <label>Gender
        <SearchableSelect name="gender" options={genderOptions} defaultValue={executive?.gender} placeholder="Select gender" required />
      </label>
      <label>Date of birth<input className="field" name="date_of_birth" required type="date" defaultValue={textValue(executive?.date_of_birth)} /></label>

      <label>Aadhaar number<input className="field" inputMode="numeric" maxLength={12} name="aadhaar_number" pattern="[0-9]{12}" placeholder="Enter Aadhaar number" required defaultValue={textValue(executive?.aadhaar_number)} /></label>
      <label>PAN number<input className="field" name="pan_number" placeholder="Enter PAN number" required defaultValue={textValue(executive?.pan_number)} /></label>
      <label>Biometric enrolment ID<input className="field" inputMode="numeric" name="biometric_id" pattern="[0-9]{1,20}" placeholder="Numeric ID from device" required defaultValue={textValue(executive?.biometric_id)} /></label>

      <label className="span-3">Address<input className="field" name="address" placeholder="Enter complete address" required defaultValue={textValue(executive?.address)} /></label>
      <label>Postal PIN<input className="field" inputMode="numeric" maxLength={6} name="postal_pin" pattern="[0-9]{6}" placeholder="Enter PIN" required defaultValue={textValue(executive?.postal_pin)} /></label>
      <label>Land mark<input className="field" name="landmark" placeholder="Enter landmark" required defaultValue={textValue(executive?.landmark)} /></label>
      <label>State
        <SearchableSelect name="state_code" options={stateOptions} defaultValue={executive?.state_code} placeholder="Search state code" required />
      </label>

      <label>Father name<input className="field" name="father_name" placeholder="Enter father name" required defaultValue={textValue(executive?.father_name)} /></label>
      <label>Blood group<input className="field" name="blood_group" placeholder="Enter blood group" required defaultValue={textValue(executive?.blood_group)} /></label>
      <label>Handicapped
        <SearchableSelect
          name="is_handicapped"
          options={yesNoOptions}
          defaultValue={typeof executive?.is_handicapped === "boolean" ? String(executive.is_handicapped) : undefined}
          placeholder="Select"
          required
        />
      </label>

      <label>Bank A/c No.<input className="field" inputMode="numeric" name="bank_account_no" placeholder="Enter bank account number" required defaultValue={textValue(executive?.bank_account_no)} /></label>
      <label>IFSC<input className="field" name="ifsc_code" placeholder="Enter IFSC" required defaultValue={textValue(executive?.ifsc_code)} /></label>
      <label>Emergency contact number<input className="field" inputMode="numeric" maxLength={10} name="emergency_contact_number" pattern="[0-9]{10}" placeholder="Enter emergency contact number" required defaultValue={textValue(executive?.emergency_contact_number)} /></label>
      <label>Emergency contact name<input className="field" name="emergency_contact_name" placeholder="Enter contact person name" required defaultValue={textValue(executive?.emergency_contact_name)} /></label>
      <label>Emergency relation<input className="field" name="emergency_contact_relation" placeholder="Enter relation" required defaultValue={textValue(executive?.emergency_contact_relation)} /></label>

      <label>Driving license no.<input className="field" name="driving_license_no" placeholder="Enter DL number" required defaultValue={textValue(executive?.driving_license_no)} /></label>
      <label>DL expiry date<input className="field" name="driving_license_exp_date" required type="date" defaultValue={textValue(executive?.driving_license_exp_date)} /></label>
      <label>Vehicle reg no.<input className="field" name="vehicle_reg_no" placeholder="Enter vehicle number" required defaultValue={textValue(executive?.vehicle_reg_no)} /></label>

      <label>Vehicle reg expiry<input className="field" name="vehicle_reg_exp_date" required type="date" defaultValue={textValue(executive?.vehicle_reg_exp_date)} /></label>
      <label>Insurance expiry<input className="field" name="vehicle_insurance_exp_date" required type="date" defaultValue={textValue(executive?.vehicle_insurance_exp_date)} /></label>
      <label>Pollution expiry<input className="field" name="vehicle_pollution_exp_date" required type="date" defaultValue={textValue(executive?.vehicle_pollution_exp_date)} /></label>

      {mode === "edit" ? (
        <>
          <label>Aadhaar front file<input className="field" name="aadhaar_front_file" type="file" /></label>
          <label>Aadhaar back file<input className="field" name="aadhaar_back_file" type="file" /></label>
          <label>DL front file<input className="field" name="dl_front_file" type="file" /></label>
          <label>DL back file<input className="field" name="dl_back_file" type="file" /></label>
          <label>Profile photo<input accept="image/*" className="field" name="profile_photo_file" type="file" /></label>
        </>
      ) : null}

      {mode === "edit" ? (
        <label>Status
          <SearchableSelect name="is_active" options={statusOptions} defaultValue={executive?.is_active ? "true" : "false"} placeholder="Select status" required />
        </label>
      ) : null}

      <div className="form-actions span-3 align-right">
        <SubmitButton disabled={!locationOptions.length} disabledText="Add location first">
          {mode === "edit" ? "Save changes" : "Add field executive"}
        </SubmitButton>
      </div>
    </form>
  );
}

function AddFieldExecutiveForm({
  locationOptions,
  values
}: {
  locationOptions: { value: string; label: string; helper?: string }[];
  values?: FieldExecutiveAddFormValues;
}) {
  return (
    <form action={createFieldExecutive} className="form-grid three field-executive-add-form">
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
      <label>Biometric enrolment ID<input className="field" inputMode="numeric" name="biometric_id" pattern="[0-9]{1,20}" placeholder="Auto generated if blank" defaultValue={values?.biometricId ?? ""} /></label>
      <div className="span-2 field-executive-location-submit">
        <label>Location
          <SearchableSelect name="location_id" options={locationOptions} defaultValue={values?.locationId} placeholder="Select location" required />
        </label>
        <div className="form-actions align-right field-executive-submit-slot">
          <SubmitButton
            confirmCancelText="No"
            confirmDescription="Please confirm before creating this Field Executive."
            confirmMessage="Do you want to submit this Field Executive registration?"
            confirmSubmitText="Yes"
            confirmTitle="Confirm submission"
            disabled={!locationOptions.length}
            disabledText="Add location first"
          >Submit</SubmitButton>
        </div>
      </div>
    </form>
  );
}

async function loadFieldExecutiveData(authorization: AuthorizationContext, editId?: string, viewId?: string) {
  if (!supabaseAdmin) {
    return {
      executives: [] as FieldExecutiveListRow[],
      locations: [] as LocationRow[],
      editExecutive: null as ExecutiveRow | null,
      viewExecutive: null as ExecutiveRow | null,
      error: "Supabase service role key is not configured."
    };
  }

  const companyId = requireCompanyId(authorization);
  let locationsResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, hide_from_location_list, providers (name), location_models (code, name)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("station_code");
  if (isMissingColumnError(locationsResult.error)) {
    locationsResult = await supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, providers (name), location_models (code, name)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code");
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
        location_id,
        designation,
        gender,
        date_of_birth,
        aadhaar_number,
        pan_number,
        address,
        postal_pin,
        landmark,
        state_code,
        father_name,
        blood_group,
        is_handicapped,
        bank_account_no,
        ifsc_code,
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
        dl_front_path,
        dl_back_path,
        profile_photo_path,
        stations (station_code, station_name, providers (name))
      `;
  const legacyExecutiveSelect = executiveSelect.replace("mobile_country_code,", "");
  let executivesResult: { data: unknown[] | null; error: { message?: string } | null } = await supabaseAdmin
    .from("field_executives")
    .select(executiveSelect)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (isMissingColumnError(executivesResult.error)) {
    executivesResult = await supabaseAdmin
      .from("field_executives")
      .select(legacyExecutiveSelect)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
  }

  const rawLocations = (locationsResult.data ?? []) as unknown as LocationRow[];
  const locations = filterLocationsByAccess(rawLocations, authorization).map((location) => ({
    ...location,
    providers: firstRelation(location.providers),
    location_models: firstRelation(location.location_models)
  })) as LocationRow[];
  const allowedLocationIds = new Set(locations.map((location) => location.id));
  const executives = ((executivesResult.data ?? []) as unknown as ExecutiveRow[])
    .filter((executive) => authorization.hasAllLocationAccess || allowedLocationIds.has(executive.location_id))
    .map((executive) => {
    const location = firstRelation(executive.stations);
    return {
      id: executive.id,
      fullName: executive.full_name,
      dropxId: executive.dropx_id ?? "-",
      biometricId: executive.biometric_id ?? "-",
      mobile: `+${executive.mobile_country_code ?? "91"} ${executive.mobile}`,
      email: executive.email,
      location: location?.station_code || "-",
      provider: firstRelation(location?.providers)?.name || "-",
      isActive: executive.is_active,
      status: fieldExecutiveStatus(executive)
    };
  });
  const uploadUrlRows = await Promise.all(((executivesResult.data ?? []) as unknown as ExecutiveRow[]).map(async (executive) => ({
    ...executive,
    upload_urls: {
      aadhaarFront: await signedDocumentUrl(executive.aadhaar_front_path),
      aadhaarBack: await signedDocumentUrl(executive.aadhaar_back_path),
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

  return {
    executives,
    locations,
    editExecutive,
    viewExecutive,
    error: executivesResult.error?.message || locationsResult.error?.message || null
  };
}

export async function FieldExecutivePageContent({
  errorMessage,
  editId,
  addFormValues,
  notice,
  viewId
}: {
  errorMessage?: string;
  editId?: string;
  addFormValues?: FieldExecutiveAddFormValues;
  notice?: string;
  viewId?: string;
}) {
  const authorization = await requirePagePermission("delivery_associates", "access");
  const permission = authorization.permissions.delivery_associates;
  const { executives, locations, editExecutive, viewExecutive, error } = await loadFieldExecutiveData(authorization, editId, viewId);
  const activeMessage = error ?? errorMessage ?? notice;
  const needsOperationModeMigration = Boolean(activeMessage?.toLowerCase().includes("operation_mode_id"));
  const locationOptions = locations.map((location) => ({
    value: location.id,
    label: location.station_code,
    helper: [firstRelation(location.providers)?.name, firstRelation(location.location_models)?.name || firstRelation(location.location_models)?.code]
      .filter(Boolean)
      .join(" - ") || location.station_name || undefined
  }));

  return (
    <AppShell active="Field Executive" pageCode="delivery_associates">
      <PageHead
        eyebrow="Workforce master"
        title="Field Executive"
        subtitle="Register and maintain field executives by location."
      />

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

      {permission.canAdd ? (
        <section className="panel">
          <div className="panel-head"><h2>Add field executive</h2></div>
          <AddFieldExecutiveForm locationOptions={locationOptions} values={addFormValues} />
        </section>
      ) : null}

      {permission.canView || permission.canEdit ? <FieldExecutiveList canEdit={permission.canEdit} rows={executives} /> : null}

      {(permission.canView || permission.canEdit) && viewExecutive ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="View field executive">
            <div className="panel-head">
              <div>
                <h2>{viewExecutive.full_name}</h2>
                <p className="subtle">Complete Field Executive profile</p>
              </div>
              <PendingLink className="icon-button" href="/field-executive" scroll={false} aria-label="Close field executive details">x</PendingLink>
            </div>
            <FieldExecutiveDetails executive={viewExecutive} />
          </section>
        </div>
      ) : null}

      {permission.canEdit && editExecutive ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit field executive">
            <div className="panel-head">
              <div>
                <h2>Edit field executive</h2>
                <p className="subtle">Maintain the full registration profile from the Team DropX sample.</p>
              </div>
              <PendingLink className="icon-button" href="/field-executive" scroll={false} aria-label="Close edit field executive">x</PendingLink>
            </div>
            <FieldExecutiveForm action={updateFieldExecutive} executive={editExecutive} locationOptions={locationOptions} mode="edit" />
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
