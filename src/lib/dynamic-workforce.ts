const systemCategoryCodes = new Set([
  "employees",
  "workforce",
  "contractors",
  "vendors",
  "workers"
]);

export const workforceCategoryPagePrefix = "workforce_category_";

const systemCategoryPageCodes: Record<string, string> = {
  employees: "employees",
  workforce: "delivery_associates",
  contractors: "contractors",
  vendors: "vendors",
  workers: "workers"
};

export function normalizeWorkforceCategoryCode(value: unknown) {
  const code = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(code) ? code : "";
}

export function isCustomWorkforceCategoryCode(value: unknown) {
  const code = normalizeWorkforceCategoryCode(value);
  return Boolean(code) && !systemCategoryCodes.has(code);
}

export function workforceCategoryPageCode(value: unknown) {
  const code = normalizeWorkforceCategoryCode(value);
  if (!code) return "";
  return systemCategoryPageCodes[code] ?? `${workforceCategoryPagePrefix}${code}`;
}

export function dynamicWorkforceTable(value: unknown) {
  const code = normalizeWorkforceCategoryCode(value);
  if (!code) throw new Error("Invalid workforce category code.");
  return `workforce_${code}`;
}

export function singularCategoryLabel(value: string) {
  const clean = value.trim();
  if (/ies$/i.test(clean)) return `${clean.slice(0, -3)}y`;
  if (/s$/i.test(clean)) return clean.slice(0, -1);
  return clean;
}
