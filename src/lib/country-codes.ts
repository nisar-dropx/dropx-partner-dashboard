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

/** Normalize user input: the selected code plus a local subscriber number. */
export function normalizeConnectMobile(mobileValue: unknown, countryCodeValue: unknown) {
  const countryCode = normalizeSupportedCountryCode(countryCodeValue);
  const { raw, digits } = phoneDigits(mobileValue);
  if (raw.startsWith("+")) {
    if (!digits.startsWith(countryCode)) {
      throw new ConnectMobileValidationError("The mobile number does not match the selected country code.");
    }
    return result(countryCode, digits.slice(countryCode.length));
  }

  const canonical = digits.startsWith(countryCode) && countryCode.length + digits.length > 15;
  return result(countryCode, canonical ? digits.slice(countryCode.length) : digits);
}

/** Normalize a trusted canonical E.164 session value. */
export function normalizeCanonicalConnectMobile(mobileValue: unknown, countryCodeValue: unknown) {
  const countryCode = normalizeSupportedCountryCode(countryCodeValue);
  const { digits } = phoneDigits(mobileValue);
  return result(countryCode, digits.startsWith(countryCode) ? digits.slice(countryCode.length) : digits);
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
