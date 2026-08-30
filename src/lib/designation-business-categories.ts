export const designationPeopleModuleOptions = [
  { value: "delivery_network", label: "Workforce" },
  { value: "people_hr", label: "HR" }
] as const;

export type DesignationPeopleModule = typeof designationPeopleModuleOptions[number]["value"];

export type DesignationBusinessCategory = {
  id: string;
  code: string;
  name: string;
  people_module: DesignationPeopleModule;
  is_active?: boolean;
};

export function normalizeDesignationPeopleModule(value: unknown): DesignationPeopleModule | null {
  const moduleCode = String(value ?? "").trim().toLowerCase();
  return designationPeopleModuleOptions.some((option) => option.value === moduleCode)
    ? moduleCode as DesignationPeopleModule
    : null;
}

export function firstDesignationBusinessCategory(value: unknown): DesignationBusinessCategory | null {
  const category = Array.isArray(value) ? value[0] : value;
  if (!category || typeof category !== "object") return null;
  const row = category as Record<string, unknown>;
  const peopleModule = normalizeDesignationPeopleModule(row.people_module);
  if (!peopleModule) return null;
  return {
    id: String(row.id ?? ""),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    people_module: peopleModule,
    is_active: row.is_active !== false
  };
}
