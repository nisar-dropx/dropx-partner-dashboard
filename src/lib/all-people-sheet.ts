import type { AllPeopleExportKey } from "@/lib/all-people-export";

export const ALL_PEOPLE_SHEET_EDITABLE_KEYS = [
  "fullName",
  "mobileCountryCode",
  "mobileNumber",
  "email",
  "dateOfJoin",
  "location",
  "designation",
  "active",
  "statutoryApplicability",
  "gender",
  "dateOfBirth",
  "aadhaarNumber",
  "panNumber",
  "eshramUan",
  "fatherName",
  "bloodGroup",
  "handicapped",
  "address",
  "stateCode",
  "pincode",
  "landmark",
  "bankAccountNumber",
  "ifsc",
  "pfUan",
  "pfAccountNumber",
  "esiNumber",
  "emergencyContactNumber",
  "emergencyContactName",
  "emergencyContactRelation",
  "drivingLicenseNumber",
  "drivingLicenseExpiry",
  "vehicleRegistrationNumber",
  "vehicleRegistrationExpiry",
  "vehicleInsuranceExpiry",
  "pollutionExpiry",
  "returnRemarks"
] as const satisfies readonly AllPeopleExportKey[];

export type AllPeopleSheetEditableKey = (typeof ALL_PEOPLE_SHEET_EDITABLE_KEYS)[number];

export type AllPeopleSheetPatchOptions = {
  employeeColumns: boolean;
  mobileDigits?: { min: number; max: number };
};

export type AllPeopleSheetPatch = {
  changedKeys: AllPeopleSheetEditableKey[];
  deferred: Partial<Record<"location" | "designation", string>>;
  payload: Record<string, string | string[] | boolean | null>;
};

const editableKeySet = new Set<string>(ALL_PEOPLE_SHEET_EDITABLE_KEYS);

const directColumns: Partial<Record<AllPeopleSheetEditableKey, string>> = {
  fullName: "full_name",
  mobileCountryCode: "mobile_country_code",
  mobileNumber: "mobile",
  email: "email",
  dateOfJoin: "date_of_join",
  active: "is_active",
  statutoryApplicability: "statutory_applicability",
  gender: "gender",
  dateOfBirth: "date_of_birth",
  aadhaarNumber: "aadhaar_number",
  panNumber: "pan_number",
  eshramUan: "eshram_uan",
  fatherName: "father_name",
  bloodGroup: "blood_group",
  handicapped: "is_handicapped",
  address: "address",
  stateCode: "state_code",
  landmark: "landmark",
  bankAccountNumber: "bank_account_no",
  pfUan: "pf_uan",
  pfAccountNumber: "pf_account_no",
  esiNumber: "esi_no",
  emergencyContactNumber: "emergency_contact_number",
  emergencyContactName: "emergency_contact_name",
  emergencyContactRelation: "emergency_contact_relation",
  drivingLicenseNumber: "driving_license_no",
  drivingLicenseExpiry: "driving_license_exp_date",
  vehicleRegistrationNumber: "vehicle_reg_no",
  vehicleRegistrationExpiry: "vehicle_reg_exp_date",
  vehicleInsuranceExpiry: "vehicle_insurance_exp_date",
  pollutionExpiry: "vehicle_pollution_exp_date",
  returnRemarks: "profile_return_remarks"
};

function optionalText(value: string, maxLength = 500) {
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`Value cannot exceed ${maxLength} characters.`);
  return normalized || null;
}

function requiredText(value: string, label: string, maxLength = 500) {
  const normalized = optionalText(value, maxLength);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function digits(value: string, label: string, min: number, max = min) {
  const normalized = value.replace(/\D/g, "");
  if (!normalized) return null;
  if (normalized.length < min || normalized.length > max) {
    throw new Error(min === max
      ? `${label} must contain exactly ${min} digits.`
      : `${label} must contain ${min} to ${max} digits.`);
  }
  return normalized;
}

function dateValue(value: string, label: string) {
  const raw = value.trim();
  if (!raw) return null;
  const displayMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const normalized = displayMatch ? `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}` : raw;
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!isoMatch) throw new Error(`Enter a valid ${label}.`);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return normalized;
}

function yesNo(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (["yes", "true", "1", "active"].includes(normalized)) return true;
  if (["no", "false", "0", "inactive"].includes(normalized)) return false;
  if (!normalized) return null;
  throw new Error(`${label} must be Yes or No.`);
}

function statutoryValues(value: string) {
  const values = Array.from(new Set(value
    .split(/[,;|]/)
    .map((item) => item.trim().toLowerCase().replace(/[ -]+/g, "_"))
    .filter(Boolean)));
  if (!values.length) return ["not_applicable"];
  const allowed = new Set(["not_applicable", "pf", "esi"]);
  if (values.some((item) => !allowed.has(item))) {
    throw new Error("Statutory applicability may contain only Not applicable, PF, or ESI.");
  }
  if (values.includes("not_applicable") && values.length > 1) {
    throw new Error("Not applicable cannot be combined with PF or ESI.");
  }
  return values;
}

function normalizeValue(key: AllPeopleSheetEditableKey, value: string, options: AllPeopleSheetPatchOptions) {
  switch (key) {
    case "fullName": return requiredText(value, "Full name", 200);
    case "mobileCountryCode": {
      const normalized = digits(value.replace(/^\+/, ""), "Mobile country code", 1, 4);
      if (!normalized) throw new Error("Mobile country code is required.");
      return normalized;
    }
    case "mobileNumber": {
      const range = options.mobileDigits ?? { min: 6, max: 15 };
      const normalized = digits(value, "Mobile number", range.min, range.max);
      if (!normalized) throw new Error("Mobile number is required.");
      return normalized;
    }
    case "email": {
      const normalized = optionalText(value, 320)?.toLowerCase() ?? null;
      if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Email format is invalid.");
      return normalized;
    }
    case "dateOfJoin": {
      const normalized = dateValue(value, "date of join");
      if (!normalized) throw new Error("Date of join is required.");
      return normalized;
    }
    case "dateOfBirth": return dateValue(value, "date of birth");
    case "drivingLicenseExpiry": return dateValue(value, "driving license expiry date");
    case "vehicleRegistrationExpiry": return dateValue(value, "vehicle registration expiry date");
    case "vehicleInsuranceExpiry": return dateValue(value, "vehicle insurance expiry date");
    case "pollutionExpiry": return dateValue(value, "pollution expiry date");
    case "aadhaarNumber": return digits(value, "Aadhaar number", 12);
    case "eshramUan": return digits(value, "eShram UAN", 12);
    case "pincode": return digits(value, "Postal PIN", 6);
    case "pfUan": return digits(value, "PF UAN", 12);
    case "emergencyContactNumber": return digits(value, "Emergency contact number", 10);
    case "panNumber": {
      const normalized = optionalText(value, 10)?.toUpperCase() ?? null;
      if (normalized && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalized)) throw new Error("PAN number format is invalid.");
      return normalized;
    }
    case "ifsc": {
      const normalized = optionalText(value, 11)?.toUpperCase() ?? null;
      if (normalized && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalized)) throw new Error("IFSC format is invalid.");
      return normalized;
    }
    case "bankAccountNumber":
    case "pfAccountNumber":
    case "esiNumber": {
      const normalized = optionalText(value, 64)?.toUpperCase() ?? null;
      if (normalized && !/^[A-Z0-9]+$/.test(normalized)) throw new Error(`${key === "bankAccountNumber" ? "Bank account number" : key === "pfAccountNumber" ? "PF account number" : "ESI number"} can contain only letters and numbers.`);
      return normalized;
    }
    case "drivingLicenseNumber":
    case "vehicleRegistrationNumber": return optionalText(value, 64)?.toUpperCase() ?? null;
    case "stateCode": return optionalText(value, 16)?.toUpperCase() ?? null;
    case "handicapped": return yesNo(value, "Handicapped");
    case "active": {
      const normalized = yesNo(value, "Active");
      if (normalized === null) throw new Error("Active is required.");
      return normalized;
    }
    case "statutoryApplicability": return statutoryValues(value);
    case "location": return requiredText(value, "Location", 100);
    case "designation": return requiredText(value, "Designation", 200);
    case "returnRemarks": return optionalText(value, 2000);
    case "address": return optionalText(value, 2000);
    default: return optionalText(value);
  }
}

/**
 * Converts a client-supplied sparse change set into a database patch. Only keys
 * present in `changes` are returned; omitted fields can never be cleared by a
 * sheet save. Location and designation remain deferred so the server action can
 * resolve their company-scoped foreign/master records before updating.
 */
export function buildAllPeopleSheetPatch(changes: unknown, options: AllPeopleSheetPatchOptions): AllPeopleSheetPatch {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("Changes must be an object.");
  }

  const entries = Object.entries(changes as Record<string, unknown>);
  if (!entries.length) throw new Error("There are no changes to save.");

  const payload: AllPeopleSheetPatch["payload"] = {};
  const deferred: AllPeopleSheetPatch["deferred"] = {};
  const changedKeys: AllPeopleSheetEditableKey[] = [];

  for (const [rawKey, rawValue] of entries) {
    if (!editableKeySet.has(rawKey)) throw new Error(`${rawKey} is read-only or is not a supported sheet field.`);
    if (typeof rawValue !== "string") throw new Error(`${rawKey} must be a text value.`);
    const key = rawKey as AllPeopleSheetEditableKey;
    const normalized = normalizeValue(key, rawValue, options);
    changedKeys.push(key);

    if (key === "location" || key === "designation") {
      deferred[key] = String(normalized);
      continue;
    }
    const column = key === "pincode"
      ? (options.employeeColumns ? "pincode" : "postal_pin")
      : key === "ifsc"
        ? (options.employeeColumns ? "ifsc" : "ifsc_code")
        : directColumns[key];
    if (!column) throw new Error(`${key} is not mapped to a profile field.`);
    payload[column] = normalized;
  }

  return { changedKeys, deferred, payload };
}
