export const PERSON_NAME_ERROR = "Full name can contain only uppercase letters and spaces.";

export function formatPersonNameInput(value: string) {
  return value.toUpperCase().replace(/[^A-Z ]/g, "").replace(/ {2,}/g, " ");
}

export function normalizePersonName(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!/^[A-Z]+(?: [A-Z]+)*$/.test(normalized)) throw new Error(PERSON_NAME_ERROR);
  return normalized;
}
