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

export function designationPeopleModuleLabel(value: unknown) {
  const peopleModule = normalizeDesignationPeopleModule(value);
  return designationPeopleModuleOptions.find((option) => option.value === peopleModule)?.label ?? "Unknown";
}
