export type ProfileFieldRule = {
  key: string;
  label: string;
  group: string;
  kind: "text" | "number" | "date" | "select" | "file";
};

export type ProfileFieldRuleSet = {
  enabled: string[];
  required: string[];
};

export type ProfileFieldChannelRules = {
  dropx_one: ProfileFieldRuleSet;
  dashboard: ProfileFieldRuleSet;
};

export type DesignationProfileFieldRules = Record<string, ProfileFieldChannelRules>;

export type ProfileFieldRuleCategory = string;

export const workforceProfileFields: ProfileFieldRule[] = [
  { key: "gender", label: "Gender", group: "Personal details", kind: "select" },
  { key: "date_of_birth", label: "Date of birth", group: "Personal details", kind: "date" },
  { key: "aadhaar_number", label: "Aadhaar number", group: "Personal details", kind: "number" },
  { key: "pan_number", label: "PAN number", group: "Personal details", kind: "text" },
  { key: "eshram_uan", label: "eShram UAN", group: "Statutory details", kind: "number" },
  { key: "father_name", label: "Father name", group: "Personal details", kind: "text" },
  { key: "blood_group", label: "Blood group", group: "Personal details", kind: "select" },
  { key: "is_handicapped", label: "Handicapped", group: "Personal details", kind: "select" },
  { key: "address", label: "Address", group: "Address", kind: "text" },
  { key: "state_code", label: "State code", group: "Address", kind: "select" },
  { key: "pincode", label: "Pincode", group: "Address", kind: "number" },
  { key: "landmark", label: "Landmark", group: "Address", kind: "text" },
  { key: "bank_account_no", label: "Bank account no", group: "Bank details", kind: "text" },
  { key: "ifsc", label: "IFSC", group: "Bank details", kind: "text" },
  { key: "pf_uan", label: "PF UAN", group: "Statutory details", kind: "text" },
  { key: "pf_account_no", label: "PF Account No", group: "Statutory details", kind: "text" },
  { key: "esi_no", label: "ESI No", group: "Statutory details", kind: "text" },
  { key: "driving_license_no", label: "Driving license no", group: "Driving and vehicle", kind: "text" },
  { key: "driving_license_exp_date", label: "DL expiry date", group: "Driving and vehicle", kind: "date" },
  { key: "vehicle_reg_no", label: "Vehicle reg no", group: "Driving and vehicle", kind: "text" },
  { key: "vehicle_reg_exp_date", label: "Vehicle reg expiry", group: "Driving and vehicle", kind: "date" },
  { key: "vehicle_insurance_exp_date", label: "Vehicle Insurance expiry", group: "Driving and vehicle", kind: "date" },
  { key: "vehicle_pollution_exp_date", label: "Pollution expiry", group: "Driving and vehicle", kind: "date" },
  { key: "emergency_contact_number", label: "Emergency contact number", group: "Emergency contact", kind: "number" },
  { key: "emergency_contact_name", label: "Emergency contact name", group: "Emergency contact", kind: "text" },
  { key: "emergency_contact_relation", label: "Emergency relation", group: "Emergency contact", kind: "select" },
  { key: "aadhaar_front", label: "Aadhaar front upload", group: "Uploads", kind: "file" },
  { key: "aadhaar_back", label: "Aadhaar back upload", group: "Uploads", kind: "file" },
  { key: "pan_upload", label: "PAN upload", group: "Uploads", kind: "file" },
  { key: "dl_front", label: "DL front upload", group: "Uploads", kind: "file" },
  { key: "dl_back", label: "DL back upload", group: "Uploads", kind: "file" },
  { key: "profile_photo", label: "Photo upload", group: "Uploads", kind: "file" }
];

export const employeeProfileFields = workforceProfileFields;
export const fieldExecutiveProfileFields = workforceProfileFields;

function normalizeRuleSet(
  value: unknown,
  fields: ProfileFieldRule[],
  defaultEnabled: string[]
): ProfileFieldRuleSet {
  const fieldKeys = new Set(fields.map((field) => field.key));
  const record = value && typeof value === "object" ? value as { enabled?: unknown; required?: unknown } : {};
  const enabled = Array.isArray(record.enabled)
    ? record.enabled.map(String).filter((key) => fieldKeys.has(key))
    : defaultEnabled.filter((key) => fieldKeys.has(key));
  const enabledSet = new Set(enabled);
  const required = Array.isArray(record.required)
    ? record.required.map(String).filter((key) => enabledSet.has(key))
    : enabled;
  return { enabled, required };
}

function normalizeChannelRules(value: unknown, fields: ProfileFieldRule[]): ProfileFieldChannelRules {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const allFieldKeys = fields.map((field) => field.key);
  const dropxOneDefaults = allFieldKeys.filter((key) => key !== "pf_account_no");
  const hasChannelRules = "dropx_one" in record || "dashboard" in record;

  if (!hasChannelRules) {
    const legacy = normalizeRuleSet(value, fields, dropxOneDefaults);
    return {
      dropx_one: legacy,
      dashboard: {
        enabled: Array.from(new Set([...legacy.enabled, ...allFieldKeys.filter((key) => key === "pf_account_no")])),
        required: legacy.required
      }
    };
  }

  return {
    dropx_one: normalizeRuleSet(record.dropx_one, fields, dropxOneDefaults),
    dashboard: normalizeRuleSet(record.dashboard, fields, allFieldKeys)
  };
}

export function normalizeProfileFieldRules(value: unknown): DesignationProfileFieldRules {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyNonEmployeeRules = record.field_executives;
  return {
    employees: normalizeChannelRules(record.employees, employeeProfileFields),
    field_executives: normalizeChannelRules(legacyNonEmployeeRules, fieldExecutiveProfileFields),
    contractors: normalizeChannelRules(record.contractors ?? legacyNonEmployeeRules, fieldExecutiveProfileFields),
    vendors: normalizeChannelRules(record.vendors ?? legacyNonEmployeeRules, fieldExecutiveProfileFields),
    helpers: normalizeChannelRules(record.helpers ?? record.workers ?? legacyNonEmployeeRules, fieldExecutiveProfileFields)
  };
}

export function profileFieldRulesForCategory(
  value: unknown,
  categoryCode: string,
  fallbackCategory = categoryCode
): ProfileFieldChannelRules {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyNonEmployeeRules = record.field_executives;
  const categoryValue = record[categoryCode]
    ?? (categoryCode === "contractors" || categoryCode === "vendors" || categoryCode === "helpers" || categoryCode === "workers"
      ? legacyNonEmployeeRules
      : record[fallbackCategory]);
  return normalizeChannelRules(categoryValue, workforceProfileFields);
}

export function intersectProfileFieldChannelRules(
  categoryRules: ProfileFieldChannelRules,
  designationRules: ProfileFieldChannelRules
): ProfileFieldChannelRules {
  const intersect = (left: string[], right: string[]) => {
    const rightSet = new Set(right);
    return left.filter((key) => rightSet.has(key));
  };
  return {
    dropx_one: {
      enabled: intersect(categoryRules.dropx_one.enabled, designationRules.dropx_one.enabled),
      required: intersect(categoryRules.dropx_one.required, designationRules.dropx_one.required)
    },
    dashboard: {
      enabled: intersect(categoryRules.dashboard.enabled, designationRules.dashboard.enabled),
      required: intersect(categoryRules.dashboard.required, designationRules.dashboard.required)
    }
  };
}

export function normalizeCategoryProfileFieldRules(value: unknown): ProfileFieldChannelRules {
  return normalizeChannelRules(value, workforceProfileFields);
}
