export const countryCodeOptions = [
  { code: "91", label: "India (+91)" },
  { code: "971", label: "UAE (+971)" },
  { code: "966", label: "Saudi Arabia (+966)" },
  { code: "974", label: "Qatar (+974)" },
  { code: "965", label: "Kuwait (+965)" },
  { code: "968", label: "Oman (+968)" },
  { code: "973", label: "Bahrain (+973)" },
  { code: "1", label: "US / Canada (+1)" },
  { code: "44", label: "United Kingdom (+44)" },
  { code: "61", label: "Australia (+61)" },
  { code: "65", label: "Singapore (+65)" },
  { code: "60", label: "Malaysia (+60)" }
] as const;

const supportedCountryCodes = new Set<string>(countryCodeOptions.map((option) => option.code));

export class ConnectMobileValidationError extends Error {}

export const MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR =
  "Mobile number and Emergency contact number cannot be same";

export function emergencyContactMatchesMobile(
  mobile: { localMobile: string; mobile: string },
  emergencyContactValue: unknown
) {
  const emergencyContact = String(emergencyContactValue ?? "").replace(/\D/g, "");
  return Boolean(
    emergencyContact &&
    (emergencyContact === mobile.localMobile || emergencyContact === mobile.mobile)
  );
}

export function normalizeSupportedCountryCode(value: unknown) {
  const raw = String(value ?? "91").trim();
  if (!/^\+?\d{1,4}$/.test(raw)) {
    throw new ConnectMobileValidationError("Select a supported mobile country code.");
  }
  const countryCode = raw.replace(/^\+/, "");
  if (!supportedCountryCodes.has(countryCode)) {
    throw new ConnectMobileValidationError("Select a supported mobile country code.");
  }
  return countryCode;
}

function phoneDigits(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\+?[\d\s().-]+$/.test(raw)) {
    throw new ConnectMobileValidationError("Enter a valid mobile number.");
  }
  return { raw, digits: raw.replace(/\D/g, "") };
}

function result(countryCode: string, localMobile: string) {
  if (!/^\d{6,14}$/.test(localMobile)) {
    throw new ConnectMobileValidationError("Enter a 6 to 14 digit mobile number.");
  }
  const mobile = `${countryCode}${localMobile}`;
  if (mobile.length > 15) {
    throw new ConnectMobileValidationError("Enter a valid mobile number for the selected country code.");
  }
  return { countryCode, localMobile, mobile };
}

/**
 * Preserve the existing Connect sign-in contract. Registration and login have
 * historically accepted both a local 10-digit number and a digit-only
 * country-prefixed number. Profile editing deliberately uses the stricter
 * normalizer below instead of changing this shared behavior.
 */
export function normalizeConnectMobile(mobileValue: unknown, countryCodeValue: unknown) {
  const countryCode = String(countryCodeValue ?? "91").replace(/\D/g, "") || "91";
  const digits = String(mobileValue ?? "").replace(/\D/g, "");
  const mobile = digits.startsWith(countryCode) && digits.length > 10
    ? digits
    : digits.length === 10
      ? `${countryCode}${digits}`
      : digits;
  const localMobile = mobile.startsWith(countryCode)
    ? mobile.slice(countryCode.length)
    : mobile;
  return { countryCode, mobile, localMobile };
}

/** Strict country-aware normalization used only by self-service profile edit. */
export function normalizeProfileEditMobile(mobileValue: unknown, countryCodeValue: unknown) {
  const countryCode = normalizeSupportedCountryCode(countryCodeValue);
  const { raw, digits } = phoneDigits(mobileValue);
  if (raw.startsWith("+")) {
    if (!digits.startsWith(countryCode)) {
      throw new ConnectMobileValidationError("The mobile number does not match the selected country code.");
    }
    return result(countryCode, digits.slice(countryCode.length));
  }
  return result(countryCode, digits);
}

/** Normalize a trusted stored session value, which is expected to be E.164. */
export function normalizeCanonicalConnectMobile(mobileValue: unknown, countryCodeValue: unknown) {
  const countryCode = normalizeSupportedCountryCode(countryCodeValue);
  const { digits } = phoneDigits(mobileValue);
  if (digits.startsWith(countryCode)) {
    return result(countryCode, digits.slice(countryCode.length));
  }
  // Compatibility for legacy sessions that stored only the local subscriber.
  return result(countryCode, digits);
}

/** Normalize a stored session written either before or after canonical E.164 storage. */
export function normalizeStoredConnectMobile(
  mobileValue: unknown,
  countryCodeValue: unknown,
  storageFormat: unknown
) {
  if (storageFormat === "canonical") {
    return normalizeCanonicalConnectMobile(mobileValue, countryCodeValue);
  }
  const countryCode = normalizeSupportedCountryCode(countryCodeValue);
  const { digits } = phoneDigits(mobileValue);
  // The legacy normalizer prefixed every 10-digit local input, and preserved an
  // already-prefixed value only when it was longer than 10 digits. Any shorter
  // stored value is therefore a local subscriber, even when it begins with the
  // same digits as its country code (for example +65 / 65912345).
  if (digits.startsWith(countryCode) && digits.length > 10) {
    return result(countryCode, digits.slice(countryCode.length));
  }
  return result(countryCode, digits);
}

export function cleanCountryCode(value: unknown) {
  return String(value ?? "91").replace(/\D/g, "") || "91";
}

/** Legacy rows without a country code are India-only and must never match another country. */
export function connectMobileCountryFilter(value: unknown) {
  const countryCode = normalizeSupportedCountryCode(value);
  return countryCode === "91"
    ? "mobile_country_code.eq.91,mobile_country_code.is.null"
    : "mobile_country_code.eq." + countryCode;
}
