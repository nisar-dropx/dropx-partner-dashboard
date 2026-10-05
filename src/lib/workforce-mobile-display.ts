export function formatWorkforceMobile(countryCode: unknown, mobile: unknown) {
  const mobileNumber = String(mobile ?? "").trim();
  if (!mobileNumber) return "-";

  const normalizedCountryCode = String(countryCode ?? "").replace(/\D/g, "") || "91";
  return `+${normalizedCountryCode} ${mobileNumber}`;
}
