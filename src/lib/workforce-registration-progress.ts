export type RegistrationLifecycle = {
  onboarding_status?: string | null;
  is_active?: boolean;
  deleted_at?: string | null;
  people_lifecycle_status?: string | null;
};

function available(row: RegistrationLifecycle) {
  return !row.deleted_at && !["suspended", "offboarding", "offboarded"].includes(String(row.people_lifecycle_status ?? "").toLowerCase());
}

export function pendingWorkforceRegistration(row: RegistrationLifecycle) {
  return available(row) && ["pending", "returned"].includes(String(row.onboarding_status ?? "").toLowerCase());
}

export function activeWorkforceRegistration(row: RegistrationLifecycle) {
  return available(row) && row.is_active === true && ["", "active"].includes(String(row.onboarding_status ?? "").toLowerCase());
}

const storedKeys: Record<string, string> = {
  pincode: "postal_pin", ifsc: "ifsc_code", aadhaar_front: "aadhaar_front_path",
  aadhaar_back: "aadhaar_back_path", pan_upload: "pan_upload_path", dl_front: "dl_front_path",
  dl_back: "dl_back_path", profile_photo: "profile_photo_path"
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Only completion flags leave the server; saved identity/bank values and draft files stay private.
export function registrationFilledFields(profile: object, draft?: { draft_data?: unknown; file_paths?: unknown } | null) {
  const source = object(profile), data = object(draft?.draft_data), files = object(draft?.file_paths);
  const keys = new Set([...Object.keys(source), ...Object.keys(data), ...Object.keys(files), ...Object.keys(storedKeys)]);
  return Object.fromEntries([...keys].map(key => {
    const value = Object.hasOwn(files, key) ? files[key] : Object.hasOwn(data, key) ? data[key] : source[storedKeys[key] ?? key];
    return [key, typeof value === "boolean" || (typeof value === "string" && value.trim() !== "") || typeof value === "number"];
  }));
}

export type RegistrationProgress = {
  filled: number; total: number; missingRequired: number;
  groups: { name: string; filled: number; total: number; missing: string[] }[];
};
export function registrationProgress(
  fields: Record<string, boolean>,
  rules: { enabled: string[]; required: string[] },
  definitions: { key: string; label: string; group: string }[]
): RegistrationProgress {
  const enabled = new Set(rules.enabled), required = new Set(rules.required);
  const selected = definitions.filter(field => enabled.has(field.key));
  const groups = [...new Set(selected.map(field => field.group))].map(name => {
    const items = selected.filter(field => field.group === name);
    return { name, filled: items.filter(field => fields[field.key]).length, total: items.length,
      missing: items.filter(field => required.has(field.key) && !fields[field.key]).map(field => field.label) };
  });
  return { filled: selected.filter(field => fields[field.key]).length, total: selected.length,
    missingRequired: selected.filter(field => required.has(field.key) && !fields[field.key]).length, groups };
}
