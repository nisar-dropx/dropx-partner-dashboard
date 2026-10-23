import type { DesignationPeopleModule } from "@/lib/designation-business-categories";

export const designationProfileDestinationOptions = [
  { value: "employees", label: "Employees" },
  { value: "field_executives", label: "Field Executives" },
  { value: "contractors", label: "Independent Contractors" },
  { value: "workers", label: "Workers" },
  { value: "workforce", label: "Workforce" },
  { value: "vendors", label: "Vendors" }
] as const;

export type DesignationProfileDestination = typeof designationProfileDestinationOptions[number]["value"];

const destinationsByPeopleModule: Record<DesignationPeopleModule, DesignationProfileDestination[]> = {
  delivery_network: ["workforce", "vendors"],
  people_hr: ["employees", "field_executives", "contractors", "workers"]
};

export function normalizeDesignationProfileDestination(value: unknown): DesignationProfileDestination | null {
  const destination = String(value ?? "").trim().toLowerCase();
  return designationProfileDestinationOptions.some((option) => option.value === destination)
    ? destination as DesignationProfileDestination
    : null;
}

export function designationProfileDestinationsForModule(peopleModule: DesignationPeopleModule) {
  const allowed = new Set(destinationsByPeopleModule[peopleModule]);
  return designationProfileDestinationOptions.filter((option) => allowed.has(option.value));
}

export function designationProfileDestinationAllowed(
  peopleModule: DesignationPeopleModule,
  destination: DesignationProfileDestination
) {
  return destinationsByPeopleModule[peopleModule].includes(destination);
}

export function designationProfileDestinationLabel(value: unknown) {
  const destination = normalizeDesignationProfileDestination(value);
  return designationProfileDestinationOptions.find((option) => option.value === destination)?.label ?? "Not set";
}
