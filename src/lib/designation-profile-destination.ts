import type { DesignationPeopleModule } from "@/lib/designation-business-categories";

export const designationProfileDestinationOptions = [
  { value: "employees", label: "Employees", table: "employees" },
  { value: "field_executives", label: "Field executives", table: "field_executives" },
  { value: "contractors", label: "Independent contractors", table: "contractors" },
  { value: "workers", label: "Workers", table: "workers" },
  { value: "workforce", label: "Workforce", table: "workforce" },
  { value: "vendors", label: "Vendors", table: "vendors" }
] as const;

export type DesignationProfileDestination = typeof designationProfileDestinationOptions[number]["value"];

const destinationsByPeopleModule: Record<DesignationPeopleModule, DesignationProfileDestination[]> = {
  delivery_network: ["workforce", "vendors"],
  people_hr: ["employees"]
};

export function normalizeDesignationProfileDestination(value: unknown): DesignationProfileDestination | null {
  const destination = String(value ?? "").trim().toLowerCase();
  return designationProfileDestinationOptions.some((option) => option.value === destination)
    ? destination as DesignationProfileDestination
    : null;
}

export function designationProfileDestinationsForModule(peopleModule: DesignationPeopleModule | null) {
  if (!peopleModule) return designationProfileDestinationOptions;
  const allowed = new Set(destinationsByPeopleModule[peopleModule]);
  return designationProfileDestinationOptions.filter((option) => allowed.has(option.value));
}

export function designationProfileDestinationAllowed(peopleModule: DesignationPeopleModule, destination: DesignationProfileDestination) {
  return destinationsByPeopleModule[peopleModule].includes(destination);
}

export function inferDesignationProfileDestination({
  onboardingCategories,
  peopleModule,
  profileDestination
}: {
  onboardingCategories?: string[] | null;
  peopleModule: DesignationPeopleModule | null;
  profileDestination?: unknown;
}): DesignationProfileDestination {
  const explicit = normalizeDesignationProfileDestination(profileDestination);
  if (explicit) return explicit;
  const categories = new Set((onboardingCategories ?? []).map((category) => String(category).trim().toLowerCase()));
  if (peopleModule === "delivery_network") return categories.has("vendors") ? "vendors" : "workforce";
  return "employees";
}

export function designationProfileDestinationLabel(value: unknown) {
  const destination = normalizeDesignationProfileDestination(value);
  return designationProfileDestinationOptions.find((option) => option.value === destination)?.label ?? "Not set";
}
