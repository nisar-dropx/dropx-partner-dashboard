import { createHmac, timingSafeEqual } from "crypto";

export const profileEditProfileTypes = [
  "employee",
  "workforce",
  "contractor",
  "vendor"
] as const;

export type ProfileEditProfileType = typeof profileEditProfileTypes[number];
export type ProfileEditPayload = Record<string, string | boolean | null>;

const payloadFieldMap = {
  gender: "gender",
  dateOfBirth: "date_of_birth",
  aadhaarNumber: "aadhaar_number",
  panNumber: "pan_number",
  eshramUan: "eshram_uan",
  isHandicapped: "is_handicapped",
  address: "address",
  state: "state",
  pincode: "pincode",
  landmark: "landmark",
  stateCode: "state_code",
  fatherName: "father_name",
  bloodGroup: "blood_group",
  bankAccountNo: "bank_account_no",
  ifsc: "ifsc",
  pfUan: "pf_uan",
  pfAccountNo: "pf_account_no",
  esiNo: "esi_no",
  drivingLicenseNo: "driving_license_no",
  drivingLicenseExpiry: "driving_license_exp_date",
  vehicleRegistrationNo: "vehicle_reg_no",
  registrationExpiry: "vehicle_reg_exp_date",
  insuranceExpiry: "vehicle_insurance_exp_date",
  pollutionExpiry: "vehicle_pollution_exp_date",
  emergencyContactName: "emergency_contact_name",
  emergencyContactNumber: "emergency_contact_number",
  emergencyContactRelation: "emergency_contact_relation"
} as const;

type ClientPayloadKey = keyof typeof payloadFieldMap;

function text(value: unknown, maxLength: number, label: string) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function digits(value: unknown, label: string, minLength: number, maxLength: number) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized) || normalized.length < minLength || normalized.length > maxLength) {
    const expected = minLength === maxLength ? `exactly ${minLength}` : `${minLength} to ${maxLength}`;
    throw new Error(`${label} must contain ${expected} digits.`);
  }
  return normalized;
}

function alphaNumeric(value: unknown, label: string, minLength: number, maxLength: number) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (!/^[A-Z0-9]+$/.test(normalized) || normalized.length < minLength || normalized.length > maxLength) {
    const expected = minLength === maxLength ? `exactly ${minLength}` : `${minLength} to ${maxLength}`;
    throw new Error(`${label} must contain ${expected} letters or digits.`);
  }
  return normalized;
}

function dateValue(value: unknown, label: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const displayMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = isoMatch
    ? normalized
    : displayMatch
      ? `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}`
      : null;
  if (!iso) throw new Error(`${label} must use dd/mm/yyyy.`);
  const [year, month, day] = iso.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid date.`);
  }
  return iso;
}

function booleanValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("Handicapped must be Yes or No.");
}

function normalizeField(key: ClientPayloadKey, value: unknown) {
  switch (key) {
    case "dateOfBirth":
      return dateValue(value, "Date of birth");
    case "drivingLicenseExpiry":
      return dateValue(value, "Driving licence expiry date");
    case "registrationExpiry":
      return dateValue(value, "Registration expiry date");
    case "insuranceExpiry":
      return dateValue(value, "Insurance expiry date");
    case "pollutionExpiry":
      return dateValue(value, "Pollution expiry date");
    case "aadhaarNumber":
      return digits(value, "Aadhaar number", 12, 12);
    case "eshramUan":
      return digits(value, "eShram UAN", 12, 12);
    case "pfUan":
      return digits(value, "PF UAN", 12, 12);
    case "pincode":
      return digits(value, "Pincode", 6, 6);
    case "emergencyContactNumber":
      return digits(value, "Emergency contact number", 4, 30);
    case "panNumber":
      return alphaNumeric(value, "PAN", 10, 10);
    case "bankAccountNo":
      return alphaNumeric(value, "Bank account number", 4, 30);
    case "ifsc":
      return alphaNumeric(value, "IFSC", 11, 11);
    case "pfAccountNo":
      return alphaNumeric(value, "PF account number", 1, 30);
    case "esiNo":
      return alphaNumeric(value, "ESI number", 1, 30);
    case "drivingLicenseNo":
      return alphaNumeric(value, "Driving licence number", 4, 30);
    case "vehicleRegistrationNo":
      return alphaNumeric(value, "Vehicle registration number", 4, 30);
    case "isHandicapped":
      return booleanValue(value);
    case "stateCode":
      return text(value, 20, "State code")?.toUpperCase() ?? null;
    case "address":
      return text(value, 1_000, "Address");
    case "gender":
      return text(value, 40, "Gender");
    case "state":
      return text(value, 120, "State");
    case "landmark":
      return text(value, 250, "Landmark");
    case "fatherName":
      return text(value, 200, "Father name");
    case "bloodGroup":
      return text(value, 20, "Blood group");
    case "emergencyContactName":
      return text(value, 200, "Emergency contact name");
    case "emergencyContactRelation":
      return text(value, 80, "Emergency contact relation");
  }
}

export function canonicalProfileEditType(value: unknown): ProfileEditProfileType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  const canonical = normalized === "field_executive" ? "workforce" : normalized;
  return profileEditProfileTypes.includes(canonical as ProfileEditProfileType)
    ? canonical as ProfileEditProfileType
    : null;
}

export function normalizeProfileEditPayload(
  value: unknown,
  profileType: ProfileEditProfileType
): ProfileEditPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile details are required.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > Object.keys(payloadFieldMap).length) {
    throw new Error("Too many profile fields were submitted.");
  }
  const normalized: ProfileEditPayload = {};
  for (const [rawKey, rawValue] of entries) {
    if (!Object.prototype.hasOwnProperty.call(payloadFieldMap, rawKey)) {
      throw new Error(`This profile field cannot be edited: ${rawKey}.`);
    }
    const key = rawKey as ClientPayloadKey;
    if (key === "state" && profileType !== "employee") {
      throw new Error("State name cannot be edited for this profile type.");
    }
    normalized[payloadFieldMap[key]] = normalizeField(key, rawValue);
  }
  return normalized;
}

export function changedProfileEditPayload(
  payload: ProfileEditPayload,
  current: Record<string, unknown>
) {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => {
    const existing = current[key];
    if (typeof value === "boolean" || typeof existing === "boolean") return value !== existing;
    return String(value ?? "") !== String(existing ?? "");
  })) as ProfileEditPayload;
}

export function missingChangedRequiredProfileField({
  payload,
  finalValues,
  requiredFields,
  exemptFields = []
}: {
  payload: ProfileEditPayload;
  finalValues: Record<string, unknown>;
  requiredFields: Iterable<string>;
  exemptFields?: Iterable<string>;
}) {
  const exemptions = new Set(exemptFields);
  for (const key of requiredFields) {
    // Self-service edits must not be blocked by unrelated legacy gaps. A
    // required field is enforced when this request actually changes it.
    if (!Object.prototype.hasOwnProperty.call(payload, key) || exemptions.has(key)) continue;
    if (!(key in finalValues)) continue; // Uploads are outside this JSON-only flow.
    const value = finalValues[key];
    const present = typeof value === "boolean" ? true : String(value ?? "").trim().length > 0;
    if (!present) return key;
  }
  return null;
}

export function createProfileEditOtpHmac({
  requestId,
  leg,
  otp,
  secret
}: {
  requestId: string;
  leg: "current" | "new";
  otp: string;
  secret: string;
}) {
  if (!secret) throw new Error("Profile edit OTP signing secret is not configured.");
  return createHmac("sha256", secret).update(`${requestId}:${leg}:${otp}`).digest("hex");
}

export function verifyProfileEditOtpHmac({
  requestId,
  leg,
  otp,
  secret,
  expected
}: {
  requestId: string;
  leg: "current" | "new";
  otp: string;
  secret: string;
  expected: string;
}) {
  const actual = createProfileEditOtpHmac({ requestId, leg, otp, secret });
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function profileEditOtpSecret() {
  const secret = process.env.CONNECT_PROFILE_EDIT_OTP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (secret.length < 32) throw new Error("Profile edit OTP signing secret is not configured.");
  return secret;
}

export function profileEditMobileHash(value: string, secret: string) {
  return createHmac("sha256", secret).update(`mobile:${value.replace(/\D/g, "")}`).digest("hex");
}

export function profileEditLocalMobile(value: unknown, countryCode: unknown, trustedCanonicalValue?: unknown) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const normalizedCountry = String(countryCode ?? "91").replace(/\D/g, "") || "91";
  if (!digits.startsWith(normalizedCountry)) return digits;

  const withoutCountry = digits.slice(normalizedCountry.length);
  const trustedDigits = String(trustedCanonicalValue ?? "").replace(/\D/g, "");
  if (trustedDigits.startsWith(normalizedCountry)) {
    const trustedLocal = trustedDigits.slice(normalizedCountry.length);
    // The authenticated session removes the ambiguity between a profile that
    // stores local digits and a legacy profile that stores digit-only E.164.
    if (digits === trustedDigits || digits === trustedLocal) return trustedLocal;
  }
  // A leading + unambiguously means the database value is E.164. For legacy
  // digit-only values, strip the prefix only for the established 10-digit
  // local format; do not guess for longer international subscriber numbers.
  if (raw.startsWith("+") || (digits.length > 10 && withoutCountry.length === 10)) {
    return withoutCountry;
  }
  return digits;
}

export function maskProfileEditMobile(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return digits;
  return `${"•".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

export function profileEditVerificationKeys(values: Record<string, unknown>) {
  const date = String(values.date_of_birth ?? "");
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const displayDate = dateMatch ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}` : date;
  const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
  return {
    pan: upper(values.pan_number),
    pan_aadhaar: [upper(values.pan_number), upper(values.aadhaar_number)].join("|"),
    bank: [upper(values.bank_account_no), upper(values.ifsc)].join("|"),
    pf_uan: upper(values.pf_uan),
    dl: [upper(values.driving_license_no), displayDate].join("|"),
    vehicle: upper(values.vehicle_reg_no)
  };
}
