export const designationCategoryOptions = [
  { value: "employees", label: "Employees" },
  { value: "vendors", label: "Vendors" },
  { value: "contractors", label: "Independent Contractor" },
  { value: "workers", label: "Workers" }
] as const;

export type DesignationCategory = string;

function normalizeCategoryCode(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  const code = raw === "delivery_executives" || raw === "field_executives"
    ? "contractors"
    : raw;
  return /^[a-z0-9_]+$/.test(code) ? code : null;
}

export function normalizeDesignationCategories(value: unknown, fallback: DesignationCategory[] = ["employees"]) {
  const values = Array.isArray(value) ? value : [];
  const normalized = Array.from(new Set(values
    .map(normalizeCategoryCode)
    .filter((item): item is string => Boolean(item))));
  return normalized.length ? normalized : fallback;
}

export function designationCategoryLabel(value: string) {
  return designationCategoryOptions.find((option) => option.value === value)?.label ?? value;
}
