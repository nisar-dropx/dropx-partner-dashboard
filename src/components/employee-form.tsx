"use client";

import { useMemo, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { countryCodeOptions } from "@/lib/country-codes";

type EmployeeFormProps = {
  action: (formData: FormData) => void;
  designationOptions: SearchableSelectOption[];
  employee?: {
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
    gender?: string | null;
    date_of_birth?: string | null;
    father_name?: string | null;
    blood_group?: string | null;
    aadhaar_number?: string | null;
    pan_number?: string | null;
    address?: string | null;
    state_code?: string | null;
    pincode?: string | null;
    landmark?: string | null;
    emergency_contact_name?: string | null;
    emergency_contact_number?: string | null;
    emergency_contact_relation?: string | null;
    bank_account_no?: string | null;
    ifsc?: string | null;
    statutory_applicability: string[] | null;
    is_active?: boolean;
  } | null;
  locationOptions: SearchableSelectOption[];
  mode?: "create" | "edit";
};

const countryCodeSelectOptions = countryCodeOptions.map((country) => ({
  value: country.code,
  label: `+${country.code}`,
  helper: country.label.replace(/\s*\(\+\d+\)\s*$/, "")
}));

const statutoryOptions = [
  { value: "not_applicable", label: "Not Applicable" },
  { value: "pf", label: "PF" },
  { value: "esi", label: "ESI" }
];

const genderOptions = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
  { value: "Other", label: "Other" }
];

const stateOptions = [
  "AP", "AR", "AS", "BR", "CG", "GA", "GJ", "HR", "HP", "JH", "KA", "KL", "MP", "MH", "MN", "ML", "MZ", "NL", "OD", "PB", "RJ", "SK", "TN", "TS", "TR", "UP", "UK", "WB", "AN", "CH", "DN", "DL", "JK", "LA", "LD", "PY"
].map((value) => ({ value, label: value }));

function StatutoryMultiSelect({ defaultValue }: { defaultValue?: string[] | null }) {
  const [selected, setSelected] = useState<string[]>(defaultValue?.length ? defaultValue : ["not_applicable"]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(value: string) {
    if (value === "not_applicable") {
      setSelected(["not_applicable"]);
      return;
    }
    const withoutNotApplicable = selected.filter((item) => item !== "not_applicable");
    const next = selectedSet.has(value)
      ? withoutNotApplicable.filter((item) => item !== value)
      : [...withoutNotApplicable, value];
    setSelected(next.length ? next : ["not_applicable"]);
  }

  return (
    <div className="tag-select">
      {selected.map((value) => <input key={value} name="statutory_applicability" type="hidden" value={value} />)}
      {statutoryOptions.map((option) => (
        <button
          aria-pressed={selectedSet.has(option.value)}
          className={`tag-select-option ${selectedSet.has(option.value) ? "selected" : ""}`}
          key={option.value}
          onClick={() => toggle(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmployeeForm({ action, designationOptions, employee, locationOptions, mode = "create" }: EmployeeFormProps) {
  const [autoGenerateEmployeeCode, setAutoGenerateEmployeeCode] = useState(mode === "create" && !employee?.employee_code);
  const isEdit = mode === "edit";

  return (
    <form action={action} className="form-grid three employee-form">
      {employee ? <input name="id" type="hidden" value={employee.id} /> : null}
      <label>
        Employee ID
        <input
          className="field"
          defaultValue={employee?.employee_code ?? ""}
          disabled={autoGenerateEmployeeCode || isEdit}
          name="employee_code"
          placeholder={autoGenerateEmployeeCode ? "Auto generated" : "Enter employee ID"}
          required={!autoGenerateEmployeeCode && !isEdit}
        />
      </label>
      {!isEdit ? <label className="check-row employee-code-auto-check">
        <input
          checked={autoGenerateEmployeeCode}
          name="auto_generate_employee_code"
          onChange={(event) => setAutoGenerateEmployeeCode(event.target.checked)}
          type="checkbox"
          value="yes"
        />
        <span>Auto generate employee ID</span>
      </label> : <div />}
      <label>
        Full name
        <input className="field" defaultValue={employee?.full_name ?? ""} name="full_name" placeholder="Enter full name" required />
      </label>
      <label>
        Biometric enrolment ID
        <input className="field" defaultValue={employee?.biometric_id ?? ""} inputMode="numeric" name="biometric_id" pattern="[0-9]{1,20}" placeholder="Auto generated if blank" />
      </label>
      <label className="field-executive-mobile-group">
        Mobile number
        <div className="field-executive-mobile-row">
          <div className="field-executive-country-code">
            <SearchableSelect name="mobile_country_code" options={countryCodeSelectOptions} defaultValue={employee?.mobile_country_code ?? "91"} placeholder="+91" required />
          </div>
          <input className="field" defaultValue={employee?.mobile ?? ""} inputMode="tel" maxLength={15} name="mobile" pattern="[0-9]{6,15}" placeholder="Enter mobile number" required />
        </div>
      </label>
      <label>
        Email
        <input className="field" defaultValue={employee?.email ?? ""} name="email" placeholder="Enter email" type="email" />
      </label>
      <label>
        Date of join
        <input className="field" defaultValue={employee?.date_of_join ?? ""} name="date_of_join" required type="date" />
      </label>
      <label>
        Location
        <SearchableSelect name="location_id" options={locationOptions} defaultValue={employee?.location_id ?? undefined} placeholder="Select location" required />
      </label>
      <label>
        Designation
        <SearchableSelect name="designation_id" options={designationOptions} defaultValue={employee?.designation_id ?? undefined} placeholder="Select designation" required />
      </label>
      <label className="span-2">
        Statutory applicability
        <StatutoryMultiSelect defaultValue={employee?.statutory_applicability} />
      </label>
      {isEdit ? (
        <>
          <label>Gender
            <SearchableSelect name="gender" options={genderOptions} defaultValue={employee?.gender ?? undefined} placeholder="Select gender" />
          </label>
          <label>Date of birth<input className="field" defaultValue={employee?.date_of_birth ?? ""} name="date_of_birth" type="date" /></label>
          <label>Blood group<input className="field" defaultValue={employee?.blood_group ?? ""} name="blood_group" placeholder="Enter blood group" /></label>
          <label>Father name<input className="field" defaultValue={employee?.father_name ?? ""} name="father_name" placeholder="Enter father name" /></label>
          <label>Aadhaar number<input className="field" defaultValue={employee?.aadhaar_number ?? ""} inputMode="numeric" maxLength={12} name="aadhaar_number" pattern="[0-9]{12}" placeholder="Enter Aadhaar number" /></label>
          <label>PAN number<input className="field" defaultValue={employee?.pan_number ?? ""} name="pan_number" placeholder="Enter PAN number" /></label>
          <label className="span-3">Address<input className="field" defaultValue={employee?.address ?? ""} name="address" placeholder="Enter complete address" /></label>
          <label>State
            <SearchableSelect name="state_code" options={stateOptions} defaultValue={employee?.state_code ?? undefined} placeholder="Select state" />
          </label>
          <label>Postal PIN<input className="field" defaultValue={employee?.pincode ?? ""} inputMode="numeric" maxLength={6} name="pincode" pattern="[0-9]{6}" placeholder="Enter PIN" /></label>
          <label>Landmark<input className="field" defaultValue={employee?.landmark ?? ""} name="landmark" placeholder="Enter landmark" /></label>
          <label>Bank account number<input className="field" defaultValue={employee?.bank_account_no ?? ""} inputMode="numeric" name="bank_account_no" placeholder="Enter bank account number" /></label>
          <label>IFSC<input className="field" defaultValue={employee?.ifsc ?? ""} name="ifsc" placeholder="Enter IFSC" /></label>
          <label>Emergency contact number<input className="field" defaultValue={employee?.emergency_contact_number ?? ""} inputMode="numeric" maxLength={10} name="emergency_contact_number" pattern="[0-9]{10}" placeholder="Enter emergency contact number" /></label>
          <label>Emergency contact name<input className="field" defaultValue={employee?.emergency_contact_name ?? ""} name="emergency_contact_name" placeholder="Enter contact person name" /></label>
          <label>Emergency relation<input className="field" defaultValue={employee?.emergency_contact_relation ?? ""} name="emergency_contact_relation" placeholder="Enter relation" /></label>
          <label>Aadhaar front file<input className="field" name="aadhaar_front_file" type="file" /></label>
          <label>Aadhaar back file<input className="field" name="aadhaar_back_file" type="file" /></label>
          <label>PAN upload<input className="field" name="pan_upload_file" type="file" /></label>
          <label>Profile photo<input accept="image/*" className="field" name="profile_photo_file" type="file" /></label>
        </>
      ) : null}
      {isEdit ? (
        <label>Status
          <select className="select" defaultValue={employee?.is_active === false ? "false" : "true"} name="is_active" required>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </label>
      ) : null}
      <div className="form-actions align-right field-executive-submit-slot">
        <SubmitButton
          confirmCancelText="No"
          confirmDescription={`Please confirm before ${isEdit ? "updating" : "creating"} this Employee.`}
          confirmMessage={`Do you want to ${isEdit ? "save" : "submit"} this Employee registration?`}
          confirmSubmitText="Yes"
          confirmTitle="Confirm submission"
          disabled={!locationOptions.length || !designationOptions.length}
          disabledText={!locationOptions.length ? "Add location first" : "Add designation first"}
        >
          {isEdit ? "Save changes" : "Submit"}
        </SubmitButton>
      </div>
    </form>
  );
}
