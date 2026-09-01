import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { CompensationBulkUpload } from "@/components/compensation-bulk-upload";
import { EmployeeForm } from "@/components/employee-form";
import { EmployeeList } from "@/components/employee-list";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { getAuthorization, hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { canOnboardDesignation } from "@/lib/designation-onboarding-access";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import { loadMappedDesignationIds } from "@/lib/designation-register-routing";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { isMissingPositionAccessSchema } from "@/lib/position-access";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforceCategoryDirectActivate, loadWorkforceCategoryRules, loadWorkforceCategoryStatutoryEnabled } from "@/lib/workforce-category-rules";
import { bulkImportEmployees, createEmployee, reviewEmployeeProfile, updateEmployee } from "./actions";
import { redirect } from "next/navigation";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  location_model_id?: string | null;
  hide_from_location_list?: boolean | null;
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

type EmployeeRow = {
  id: string;
  employee_code: string | null;
  biometric_id?: string | null;
  full_name: string;
  mobile_country_code: string | null;
  mobile: string;
  email: string | null;
  date_of_join: string;
  location_id?: string | null;
  designation_id?: string | null;
  org_position_id?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  father_name?: string | null;
  blood_group?: string | null;
  address?: string | null;
  state_code?: string | null;
  pincode?: string | null;
  landmark?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_number?: string | null;
  emergency_contact_relation?: string | null;
  statutory_applicability: string[] | null;
  profile_completion_status?: string | null;
  profile_return_remarks?: string | null;
  profile_completed_at?: string | null;
  aadhaar_number?: string | null;
  pan_number?: string | null;
  eshram_uan?: string | null;
  is_handicapped?: boolean | null;
  bank_account_no?: string | null;
  ifsc?: string | null;
  pf_uan?: string | null;
  pf_account_no?: string | null;
  esi_no?: string | null;
  driving_license_no?: string | null;
  driving_license_exp_date?: string | null;
  vehicle_reg_no?: string | null;
  vehicle_reg_exp_date?: string | null;
  vehicle_insurance_exp_date?: string | null;
  vehicle_pollution_exp_date?: string | null;
  aadhaar_front_path?: string | null;
  aadhaar_back_path?: string | null;
  pan_upload_path?: string | null;
  dl_front_path?: string | null;
  dl_back_path?: string | null;
  profile_photo_path?: string | null;
  upload_urls?: Record<string, string>;
  is_active: boolean;
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
  designations?: { code: string; name: string } | { code: string; name: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function loadFlash() {
  const raw = cookies().get("dropx_employees_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

function statutoryLabel(values: string[] | null | undefined) {
  const labels = new Map([
    ["not_applicable", "Not Applicable"],
    ["pf", "PF"],
    ["esi", "ESI"]
  ]);
  const selected = values?.length ? values : ["not_applicable"];
  return selected.map((value) => labels.get(value) ?? value).join(", ");
}

function employeeStatus(employee: EmployeeRow) {
  if (!employee.is_active) return "Inactive";
  if (employee.profile_completion_status === "active") return "Active";
  if (employee.profile_completion_status === "under_review") return "Under review";
  if (employee.profile_completion_status === "returned") return "Returned";
  if (employee.profile_completion_status === "submitted") return "Submitted";
  if (employee.profile_completion_status === "rejected") return "Rejected";
  const hasCompletedProfile = [
    employee.aadhaar_number,
    employee.pan_number,
    employee.bank_account_no,
    employee.ifsc,
    employee.aadhaar_front_path,
    employee.aadhaar_back_path,
    employee.pan_upload_path,
    employee.profile_photo_path
  ].every((value) => String(value ?? "").trim().length > 0);
  if (employee.profile_completion_status === "active" && employee.profile_completed_at && hasCompletedProfile) return "Active";
  return "Pending";
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function displayValue(value: string | boolean | null | undefined) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value || "-";
}

function EmployeeDetail({ label, value }: { label: string; value: string | boolean | null | undefined }) {
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

function EmployeeDetails({
  dashboardRules,
  employee
}: {
  dashboardRules: { enabled: string[]; required: string[] };
  employee: EmployeeRow;
}) {
  const location = firstRelation(employee.stations);
  const designation = firstRelation(employee.designations);
  const enabled = new Set(dashboardRules.enabled);
  const hasAny = (...keys: string[]) => keys.some((key) => enabled.has(key));
  return (
    <div className="executive-details">
      <section>
        <h3>Employment</h3>
        <dl className="executive-detail-grid">
          <EmployeeDetail label="Employee ID" value={employee.employee_code} />
          <EmployeeDetail label="Full name" value={employee.full_name} />
          <EmployeeDetail label="Biometric ID" value={employee.biometric_id} />
          <EmployeeDetail label="Date of join" value={formatDashboardDate(employee.date_of_join)} />
          <EmployeeDetail label="Location" value={location?.station_name || location?.station_code} />
          <EmployeeDetail label="Designation" value={designation?.name} />
          <EmployeeDetail label="Statutory" value={statutoryLabel(employee.statutory_applicability)} />
          <EmployeeDetail label="Status" value={employeeStatus(employee)} />
        </dl>
      </section>
      <section>
        <h3>Personal and contact</h3>
        <dl className="executive-detail-grid">
          <EmployeeDetail label="Mobile" value={`+${employee.mobile_country_code ?? "91"} ${employee.mobile}`} />
          <EmployeeDetail label="Email" value={employee.email} />
          {enabled.has("gender") ? <EmployeeDetail label="Gender" value={employee.gender} /> : null}
          {enabled.has("date_of_birth") ? <EmployeeDetail label="Date of birth" value={formatDashboardDate(employee.date_of_birth)} /> : null}
          {enabled.has("father_name") ? <EmployeeDetail label="Father name" value={employee.father_name} /> : null}
          {enabled.has("blood_group") ? <EmployeeDetail label="Blood group" value={employee.blood_group} /> : null}
          {enabled.has("is_handicapped") ? <EmployeeDetail label="Handicapped" value={employee.is_handicapped} /> : null}
        </dl>
      </section>
      {hasAny("emergency_contact_number", "emergency_contact_name", "emergency_contact_relation") ? <section>
        <h3>Emergency contact</h3>
        <dl className="executive-detail-grid">
          {enabled.has("emergency_contact_number") ? <EmployeeDetail label="Contact number" value={employee.emergency_contact_number} /> : null}
          {enabled.has("emergency_contact_name") ? <EmployeeDetail label="Contact name" value={employee.emergency_contact_name} /> : null}
          {enabled.has("emergency_contact_relation") ? <EmployeeDetail label="Relation" value={employee.emergency_contact_relation} /> : null}
        </dl>
      </section> : null}
      {hasAny("aadhaar_number", "pan_number", "address", "state_code", "pincode", "landmark") ? <section>
        <h3>Identity and address</h3>
        <dl className="executive-detail-grid">
          {enabled.has("aadhaar_number") ? <EmployeeDetail label="Aadhaar number" value={employee.aadhaar_number} /> : null}
          {enabled.has("pan_number") ? <EmployeeDetail label="PAN number" value={employee.pan_number} /> : null}
          {enabled.has("address") ? <EmployeeDetail label="Address" value={employee.address} /> : null}
          {enabled.has("state_code") ? <EmployeeDetail label="State" value={employee.state_code} /> : null}
          {enabled.has("pincode") ? <EmployeeDetail label="Postal PIN" value={employee.pincode} /> : null}
          {enabled.has("landmark") ? <EmployeeDetail label="Landmark" value={employee.landmark} /> : null}
        </dl>
      </section> : null}
      {hasAny("eshram_uan", "pf_uan", "pf_account_no", "esi_no") ? <section>
        <h3>Statutory</h3>
        <dl className="executive-detail-grid">
          {enabled.has("eshram_uan") ? <EmployeeDetail label="eShram UAN" value={employee.eshram_uan} /> : null}
          {enabled.has("pf_uan") ? <EmployeeDetail label="PF UAN" value={employee.pf_uan} /> : null}
          {enabled.has("pf_account_no") ? <EmployeeDetail label="PF Account No" value={employee.pf_account_no} /> : null}
          {enabled.has("esi_no") ? <EmployeeDetail label="ESI No" value={employee.esi_no} /> : null}
        </dl>
      </section> : null}
      {hasAny("driving_license_no", "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date", "vehicle_pollution_exp_date") ? <section>
        <h3>License and vehicle</h3>
        <dl className="executive-detail-grid">
          {enabled.has("driving_license_no") ? <EmployeeDetail label="Driving license number" value={employee.driving_license_no} /> : null}
          {enabled.has("driving_license_exp_date") ? <EmployeeDetail label="Driving license expiry" value={formatDashboardDate(employee.driving_license_exp_date)} /> : null}
          {enabled.has("vehicle_reg_no") ? <EmployeeDetail label="Vehicle registration number" value={employee.vehicle_reg_no} /> : null}
          {enabled.has("vehicle_reg_exp_date") ? <EmployeeDetail label="Vehicle registration expiry" value={formatDashboardDate(employee.vehicle_reg_exp_date)} /> : null}
          {enabled.has("vehicle_insurance_exp_date") ? <EmployeeDetail label="Vehicle Insurance expiry" value={formatDashboardDate(employee.vehicle_insurance_exp_date)} /> : null}
          {enabled.has("vehicle_pollution_exp_date") ? <EmployeeDetail label="Pollution expiry" value={formatDashboardDate(employee.vehicle_pollution_exp_date)} /> : null}
        </dl>
      </section> : null}
      {hasAny("bank_account_no", "ifsc") ? <section>
        <h3>Bank</h3>
        <dl className="executive-detail-grid">
          {enabled.has("bank_account_no") ? <EmployeeDetail label="Bank account number" value={employee.bank_account_no} /> : null}
          {enabled.has("ifsc") ? <EmployeeDetail label="IFSC" value={employee.ifsc} /> : null}
        </dl>
      </section> : null}
      {hasAny("aadhaar_front", "aadhaar_back", "pan_upload", "dl_front", "dl_back", "profile_photo") ? <section>
        <h3>Uploads</h3>
        <dl className="executive-detail-grid">
          {enabled.has("aadhaar_front") ? <UploadDetail label="Aadhaar front" url={employee.upload_urls?.aadhaarFront} /> : null}
          {enabled.has("aadhaar_back") ? <UploadDetail label="Aadhaar back" url={employee.upload_urls?.aadhaarBack} /> : null}
          {enabled.has("pan_upload") ? <UploadDetail label="PAN upload" url={employee.upload_urls?.pan} /> : null}
          {enabled.has("dl_front") ? <UploadDetail label="DL front" url={employee.upload_urls?.dlFront} /> : null}
          {enabled.has("dl_back") ? <UploadDetail label="DL back" url={employee.upload_urls?.dlBack} /> : null}
          {enabled.has("profile_photo") ? <UploadDetail label="Profile photo" url={employee.upload_urls?.profilePhoto} /> : null}
        </dl>
      </section> : null}
    </div>
  );
}

function EmployeeBulkImportPanel() {
  return (
    <section className="panel workforce-bulk-panel">
      <div className="panel-head">
        <div>
          <h2>Bulk upload employees</h2>
          <p className="subtle">Upload existing employee rows and keep the profile completion pending for the app.</p>
        </div>
      </div>
      <form action={bulkImportEmployees} className="workforce-bulk-form">
        <div className="workforce-template-note">
          <strong>Employee upload template</strong>
          <span>Download the prepared Excel, fill one employee per row, and upload the completed file.</span>
          <a className="template-download-link" download href="/api/import-template?kind=employee">Download sample Excel</a>
        </div>
        <input accept=".xlsx,.xls,.csv" className="field" name="bulk_file" required type="file" />
        <SubmitButton
          confirmCancelText="No"
          confirmDescription="This will create pending employee profiles from the uploaded file."
          confirmMessage="Import employees from this file?"
          confirmSubmitText="Yes"
          confirmTitle="Confirm bulk upload"
        >
          Upload employees
        </SubmitButton>
      </form>
    </section>
  );
}

async function signedDocumentUrl(path: string | null | undefined) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

async function loadEmployees(companyId: string, authorization: AuthorizationContext, editId?: string, viewId?: string) {
  const ownerAccess = isCompanyOwner(authorization);
  if (!supabaseAdmin) {
    return {
      employees: [] as EmployeeRow[],
      locations: [] as LocationRow[],
      designations: [] as DesignationRow[],
      positions: [] as Array<{ id: string; code: string; name: string; designation_id: string | null; location_access_mode: string; location_scope_ids: string[] | null }>,
      error: "Supabase service role key is not configured."
    };
  }

  const mappedEmployeeDesignationIds = await loadMappedDesignationIds(companyId, "employees");

  const [initialEmployeesResult, locationsResult, designationsResult, positionsResult] = await Promise.all([
    supabaseAdmin
      .from("employees")
      .select("id, employee_code, biometric_id, full_name, mobile_country_code, mobile, email, date_of_join, location_id, designation_id, org_position_id, statutory_applicability, profile_completion_status, profile_return_remarks, profile_completed_at, gender, date_of_birth, aadhaar_number, pan_number, eshram_uan, father_name, blood_group, is_handicapped, address, state_code, pincode, landmark, emergency_contact_name, emergency_contact_number, emergency_contact_relation, bank_account_no, ifsc, pf_uan, pf_account_no, esi_no, driving_license_no, driving_license_exp_date, vehicle_reg_no, vehicle_reg_exp_date, vehicle_insurance_exp_date, vehicle_pollution_exp_date, aadhaar_front_path, aadhaar_back_path, pan_upload_path, dl_front_path, dl_back_path, profile_photo_path, is_active, stations (station_code, station_name, providers (name), location_models (code, name)), designations (code, name)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, location_model_id, hide_from_location_list")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code"),
    supabaseAdmin
      .from("designations")
      .select("id, code, name, model_ids, onboarding_categories, profile_field_rules, onboarding_role_ids, portal_permissions, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabaseAdmin
      .from("org_positions")
      .select("id, code, name, designation_id, location_access_mode, location_scope_ids")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
  ]);
  let employeesResult = initialEmployeesResult;
  if (isMissingColumnError(initialEmployeesResult.error)) {
    const fallbackEmployeesResult = await supabaseAdmin
      .from("employees")
      .select("id, employee_code, full_name, mobile_country_code, mobile, email, date_of_join, statutory_applicability, is_active, stations (station_code, station_name, providers (name), location_models (code, name)), designations (code, name)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    employeesResult = {
      ...fallbackEmployeesResult,
      data: (fallbackEmployeesResult.data ?? []).map((employee) => ({ ...employee, profile_completion_status: "pending", profile_completed_at: null }))
    } as typeof initialEmployeesResult;
  }

  if (employeesResult.error) {
    return { employees: [], locations: [], designations: [], positions: [], error: employeesResult.error.message };
  }
  if (locationsResult.error) {
    return { employees: [], locations: [], designations: [], positions: [], error: locationsResult.error.message };
  }
  let designationRows = designationsResult.data ?? [];
  let designationError = designationsResult.error;
  if (isMissingColumnError(designationsResult.error)) {
    const fallbackDesignationsResult = await supabaseAdmin
      .from("designations")
      .select("id, code, name, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name");
    designationRows = (fallbackDesignationsResult.data ?? []).map((designation) => ({ ...designation, model_ids: [], onboarding_categories: ["employees"], profile_field_rules: {}, onboarding_role_ids: [], portal_permissions: null }));
    designationError = fallbackDesignationsResult.error;
  }

  if (designationError) {
    return { employees: [], locations: [], designations: [], positions: [], error: designationError.message };
  }
  if (positionsResult.error && !isMissingPositionAccessSchema(positionsResult.error)) {
    return { employees: [], locations: [], designations: [], positions: [], error: positionsResult.error.message };
  }

  const allowedLocations = filterOnboardingLocations(locationsResult.data ?? [], authorization);
  const allowedCodes = new Set(allowedLocations.map((location) => location.station_code));
  const employees = authorization.hasAllLocationAccess
    ? (employeesResult.data ?? [])
    : (employeesResult.data ?? []).filter((employee) => {
      const location = firstRelation(employee.stations);
      return location?.station_code ? allowedCodes.has(location.station_code) : false;
    });

  const employeeDesignations = new Map((designationRows as DesignationRow[]).map((designation) => [designation.id, designation]));
  const visibleEmployees = (employees as EmployeeRow[]).filter((employee) => {
    const designation = employee.designation_id ? employeeDesignations.get(employee.designation_id) : null;
    return Boolean(designation?.onboarding_categories?.includes("employees"))
      && canAccessDesignationPortal(designation, "dashboard", "view", { isOwner: ownerAccess });
  });

  const employeesWithUrls = await Promise.all(visibleEmployees.map(async (employee) => ({
    ...employee,
    upload_urls: {
      aadhaarFront: await signedDocumentUrl(employee.aadhaar_front_path),
      aadhaarBack: await signedDocumentUrl(employee.aadhaar_back_path),
      pan: await signedDocumentUrl(employee.pan_upload_path),
      dlFront: await signedDocumentUrl(employee.dl_front_path),
      dlBack: await signedDocumentUrl(employee.dl_back_path),
      profilePhoto: await signedDocumentUrl(employee.profile_photo_path)
    }
  })));

  return {
    employees: employeesWithUrls,
    editEmployee: editId ? employeesWithUrls.find((employee) => employee.id === editId) ?? null : null,
    viewEmployee: viewId ? employeesWithUrls.find((employee) => employee.id === viewId) ?? null : null,
    locations: allowedLocations as LocationRow[],
    designations: (designationRows as DesignationRow[])
      .filter((designation) => designation.onboarding_categories?.includes("employees"))
      .filter((designation) => mappedEmployeeDesignationIds.has(designation.id)),
    positions: positionsResult.error && isMissingPositionAccessSchema(positionsResult.error) ? [] : (positionsResult.data ?? []),
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function EmployeesPage({ searchParams }: { searchParams?: { edit?: string; view?: string } }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const hasEmployeeAccess = hasPermission(authorization, "employees", "access");
  const hasPeopleAccess = hasPermission(authorization, "people_all", "access");
  if (!hasEmployeeAccess && !hasPeopleAccess) redirect("/unauthorized?page=employees&action=access");
  const ownerAccess = isCompanyOwner(authorization);
  const companyId = requireCompanyId(authorization);
  const employeePermission = authorization.permissions.employees;
  const pagePermission = {
    canView: hasPermission(authorization, "employees", "view") || hasPeopleAccess,
    canAdd: employeePermission?.canAdd ?? false,
    canEdit: employeePermission?.canEdit ?? false
  };
  const { employees, editEmployee, locations, designations, positions, error, viewEmployee } = await loadEmployees(companyId, authorization, searchParams?.edit, searchParams?.view);
  const flash = loadFlash();
  const locationOptions = locations.map((location) => ({
    value: location.id,
    label: location.station_code,
    helper: location.station_name ?? undefined,
    modelId: location.location_model_id ?? null
  }));
  const employeeCategoryRules = await loadWorkforceCategoryRules(
    companyId,
    "employees",
    undefined,
    "employees"
  );
  const employeeStatutoryEnabled = await loadWorkforceCategoryStatutoryEnabled(companyId, "employees", true);
  const employeeDirectActivate = await loadWorkforceCategoryDirectActivate(companyId, "employees");
  const designationOptions = await Promise.all(designations.map(async (designation) => ({
    value: designation.id,
    label: designation.name,
    helper: designation.code,
    modelIds: designation.model_ids ?? [],
      canEdit: canAccessDesignationPortal(designation, "dashboard", "edit", { isOwner: ownerAccess }),
    dashboardRules: (await loadWorkforceCategoryRules(
      companyId,
      "employees",
      designation.profile_field_rules,
      "employees"
    )).dashboard
  })));
  const onboardingDesignationOptions = designationOptions.filter((option) => {
    const designation = designations.find((row) => row.id === option.value);
    return designation
        ? canAccessDesignationPortal(designation, "dashboard", "add", { isOwner: ownerAccess }) && canOnboardDesignation(designation, authorization)
      : false;
  });
  const editDesignationOptions = designationOptions.filter((option) => option.canEdit);
  const positionOptions = positions.map((position) => ({
    value: position.id,
    label: position.name,
    helper: position.code,
    designationId: position.designation_id,
    allLocations: position.location_access_mode === "all_locations",
    locationScopeIds: position.location_scope_ids ?? []
  }));
  const viewRules = designationOptions.find((option) => option.value === viewEmployee?.designation_id)?.dashboardRules
    ?? employeeCategoryRules.dashboard;

  return (
    <AppShell active="Employees" pageCode="employees">
      <PageHead
        eyebrow="Workforce Master"
        title="Employees"
        subtitle="Register and maintain employees by location."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/employees_v1.sql` in Supabase SQL Editor, then refresh this page.
            </p>
          </div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head"><h2>Add employee</h2></div>
          <EmployeeForm action={createEmployee} dashboardRules={employeeCategoryRules.dashboard} designationOptions={onboardingDesignationOptions} directActivate={employeeDirectActivate} locationOptions={locationOptions} positionOptions={positionOptions} statutoryEnabled={employeeStatutoryEnabled} />
        </section>
      ) : null}

      {!error && pagePermission.canAdd ? <EmployeeBulkImportPanel /> : null}
      {!error && ownerAccess ? <CompensationBulkUpload kind="employee_salary" /> : null}

      {!error && pagePermission.canView ? (
        <EmployeeList
          canEdit={pagePermission.canEdit}
          rows={employees.map((employee) => {
            const location = firstRelation(employee.stations);
            const provider = firstRelation(location?.providers);
            const model = firstRelation(location?.location_models);
            const designation = firstRelation(employee.designations);
            return {
              id: employee.id,
              employeeCode: employee.employee_code ?? "-",
              biometricId: employee.biometric_id ?? "-",
              fullName: employee.full_name,
              mobile: `+${employee.mobile_country_code ?? "91"} ${employee.mobile}`,
              email: employee.email || "-",
              dateOfJoin: employee.date_of_join,
              location: location?.station_code ?? "-",
              provider: provider?.name ?? "-",
              model: model?.code || model?.name || "-",
              designation: designation?.name ?? "-",
              statutory: statutoryLabel(employee.statutory_applicability),
              status: employeeStatus(employee),
              canEdit: designationOptions.find((option) => option.value === employee.designation_id)?.canEdit ?? true,
              profilePhotoUrl: employee.upload_urls?.profilePhoto ?? null
            };
          })}
        />
      ) : null}

      {!error && pagePermission.canView && viewEmployee ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="View employee">
            <div className="panel-head">
              <div>
                <h2>{viewEmployee.full_name}</h2>
                <p className="subtle">Complete Employee profile</p>
              </div>
              <PendingLink className="icon-button" href="/employees" scroll={false} aria-label="Close employee details">x</PendingLink>
            </div>
            <EmployeeDetails dashboardRules={viewRules} employee={viewEmployee} />
          </section>
        </div>
      ) : null}

      {!error && pagePermission.canEdit && editEmployee ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit employee">
            <div className="panel-head">
              <div>
                <h2>Edit employee</h2>
                <p className="subtle">Maintain employee registration details.</p>
              </div>
              <PendingLink className="icon-button" href="/employees" scroll={false} aria-label="Close edit employee">x</PendingLink>
            </div>
            <EmployeeForm action={updateEmployee} dashboardRules={employeeCategoryRules.dashboard} designationOptions={editDesignationOptions} employee={editEmployee} locationOptions={locationOptions} mode="edit" positionOptions={positionOptions} statutoryEnabled={employeeStatutoryEnabled} />
            {editEmployee.profile_completion_status === "under_review" ? (
              <section className="profile-review-panel">
                <div className="profile-review-head">
                  <div>
                    <span className="profile-review-eyebrow">Profile decision</span>
                    <h3>Review employee profile</h3>
                    <p>Approve the submitted details or return the profile with clear correction remarks.</p>
                  </div>
                </div>
                <div className="profile-review-options">
                  <div className="profile-review-option profile-review-option-approve">
                    <div>
                      <h4>Approve profile</h4>
                      <p>Confirm the information and activate this profile.</p>
                    </div>
                    <form action={reviewEmployeeProfile} className="profile-review-approve">
                      <input name="id" type="hidden" value={editEmployee.id} />
                      <input name="review_action" type="hidden" value="approve" />
                      <SubmitButton className="button profile-review-approve-button" pendingText="Approving...">Approve profile</SubmitButton>
                    </form>
                  </div>
                  <div className="profile-review-option profile-review-option-return">
                    <div>
                      <h4>Return for correction</h4>
                      <p>The employee will see these remarks before resubmitting.</p>
                    </div>
                    <form action={reviewEmployeeProfile} className="profile-review-return">
                      <input name="id" type="hidden" value={editEmployee.id} />
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
