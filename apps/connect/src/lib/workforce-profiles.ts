export const workforceProfileTypes = [
  "employee",
  "workforce",
  "field_executive",
  "contractor",
  "vendor",
  "worker"
] as const;

export type WorkforceProfileType = typeof workforceProfileTypes[number];
export type NonEmployeeProfileType = Exclude<WorkforceProfileType, "employee">;

const tables: Record<NonEmployeeProfileType, "workforce" | "contractors" | "vendors" | "helpers"> = {
  workforce: "workforce",
  field_executive: "workforce",
  contractor: "contractors",
  vendor: "vendors",
  worker: "helpers"
};

export function isWorkforceProfileType(value: unknown): value is WorkforceProfileType {
  return workforceProfileTypes.includes(String(value) as WorkforceProfileType);
}

export function isNonEmployeeProfileType(value: unknown): value is NonEmployeeProfileType {
  return isWorkforceProfileType(value) && value !== "employee";
}

export function workforceTable(profileType: WorkforceProfileType) {
  return profileType === "employee" ? "employees" as const : tables[profileType];
}

export function workforceLabel(profileType: NonEmployeeProfileType) {
  if (profileType === "workforce") return "Workforce";
  if (profileType === "contractor") return "Independent contractor";
  if (profileType === "vendor") return "Vendor";
  if (profileType === "worker") return "Worker";
  return "Field executive";
}

export function profileFieldRuleCategory(profileType: NonEmployeeProfileType) {
  if (profileType === "workforce") return "workforce" as const;
  if (profileType === "contractor") return "contractors" as const;
  if (profileType === "vendor") return "vendors" as const;
  if (profileType === "worker") return "helpers" as const;
  return "workforce" as const;
}
