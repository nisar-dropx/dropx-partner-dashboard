export const workforceProfileTypes = [
  "employee",
  "field_executive",
  "contractor",
  "vendor",
  "worker"
] as const;

export type WorkforceProfileType = typeof workforceProfileTypes[number];
export type NonEmployeeProfileType = Exclude<WorkforceProfileType, "employee">;

export type NonEmployeeRoute =
  | "/field-executive"
  | "/work-force-register"
  | "/contractors"
  | "/vendors"
  | "/workers";

type NonEmployeeConfig = {
  category: "field_executive" | "contractor" | "vendor" | "worker";
  designationCategory: "field_executives" | "contractors" | "vendors" | "workers";
  label: string;
  pageCode: "delivery_associates" | "contractors" | "vendors" | "workers";
  profileType: NonEmployeeProfileType;
  route: NonEmployeeRoute;
  table: "field_executives" | "contractors" | "vendors" | "workers";
};

export const nonEmployeeProfileConfigs: Record<NonEmployeeProfileType, NonEmployeeConfig> = {
  field_executive: {
    category: "field_executive",
    designationCategory: "field_executives",
    label: "Workforce applicant",
    pageCode: "delivery_associates",
    profileType: "field_executive",
    route: "/field-executive",
    table: "field_executives"
  },
  contractor: {
    category: "contractor",
    designationCategory: "contractors",
    label: "Independent contractor",
    pageCode: "contractors",
    profileType: "contractor",
    route: "/contractors",
    table: "contractors"
  },
  vendor: {
    category: "vendor",
    designationCategory: "vendors",
    label: "Vendor",
    pageCode: "vendors",
    profileType: "vendor",
    route: "/vendors",
    table: "vendors"
  },
  worker: {
    category: "worker",
    designationCategory: "workers",
    label: "Worker",
    pageCode: "workers",
    profileType: "worker",
    route: "/workers",
    table: "workers"
  }
};

export function isWorkforceProfileType(value: unknown): value is WorkforceProfileType {
  return workforceProfileTypes.includes(String(value) as WorkforceProfileType);
}

export function isNonEmployeeProfileType(value: unknown): value is NonEmployeeProfileType {
  return isWorkforceProfileType(value) && value !== "employee";
}

export function nonEmployeeConfigForProfileType(value: unknown) {
  return isNonEmployeeProfileType(value) ? nonEmployeeProfileConfigs[value] : null;
}

export function nonEmployeeConfigForRoute(value: unknown) {
  const route = String(value ?? "") as NonEmployeeRoute;
  if (route === "/work-force-register") {
    return { ...nonEmployeeProfileConfigs.contractor, route };
  }
  return Object.values(nonEmployeeProfileConfigs).find((config) => config.route === route) ??
    nonEmployeeProfileConfigs.field_executive;
}

export function workforceTable(profileType: WorkforceProfileType) {
  return profileType === "employee"
    ? "employees" as const
    : nonEmployeeProfileConfigs[profileType].table;
}

export function workforceLabel(profileType: NonEmployeeProfileType) {
  return nonEmployeeProfileConfigs[profileType].label;
}
