export const workforceProfileTypes = [
  "employee",
  "workforce",
  "field_executive",
  "contractor",
  "vendor",
  "worker"
] as const;

export type WorkforceProfileType = typeof workforceProfileTypes[number];
export type NonEmployeeProfileType = Exclude<WorkforceProfileType, "employee" | "workforce">;

export type NonEmployeeRoute =
  | "/workforce"
  | "/field-executive"
  | "/work-force-register"
  | "/work-force-register/helpers"
  | "/work-force-register/vendors"
  | "/contractors"
  | "/vendors"
  | "/workers";

type NonEmployeeConfig = {
  category: "field_executive" | "contractor" | "vendor" | "worker";
  designationCategory: "workforce" | "contractors" | "vendors" | "workers";
  label: string;
  pageCode: "delivery_associates" | "contractors" | "vendors" | "workers";
  profileType: NonEmployeeProfileType;
  route: NonEmployeeRoute;
  table: "workforce" | "contractors" | "vendors" | "workers";
};

export const nonEmployeeProfileConfigs: Record<NonEmployeeProfileType, NonEmployeeConfig> = {
  field_executive: {
    category: "field_executive",
    designationCategory: "workforce",
    label: "Workforce applicant",
    pageCode: "delivery_associates",
    profileType: "field_executive",
    route: "/workforce",
    table: "workforce"
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
  return isWorkforceProfileType(value) && value !== "employee" && value !== "workforce";
}

export function nonEmployeeConfigForProfileType(value: unknown) {
  return isNonEmployeeProfileType(value) ? nonEmployeeProfileConfigs[value] : null;
}

export function nonEmployeeConfigForRoute(value: unknown) {
  const route = String(value ?? "") as NonEmployeeRoute;
  if (route === "/field-executive") {
    return nonEmployeeProfileConfigs.field_executive;
  }
  if (route === "/work-force-register") {
    return { ...nonEmployeeProfileConfigs.contractor, route };
  }
  if (route === "/work-force-register/helpers") {
    return { ...nonEmployeeProfileConfigs.worker, pageCode: "contractors" as const, route };
  }
  if (route === "/work-force-register/vendors") {
    return { ...nonEmployeeProfileConfigs.vendor, pageCode: "contractors" as const, route };
  }
  return Object.values(nonEmployeeProfileConfigs).find((config) => config.route === route) ??
    nonEmployeeProfileConfigs.field_executive;
}

export function workforceTable(profileType: WorkforceProfileType) {
  if (profileType === "employee") return "employees" as const;
  if (profileType === "workforce") return "workforce" as const;
  return nonEmployeeProfileConfigs[profileType].table;
}

export function workforceLabel(profileType: NonEmployeeProfileType) {
  return nonEmployeeProfileConfigs[profileType].label;
}
