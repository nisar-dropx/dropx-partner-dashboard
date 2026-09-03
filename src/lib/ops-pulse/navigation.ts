import { fleetNavItem, type NavItem } from "@/lib/app-navigation";
import { hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import type { OperatingMode } from "@/lib/ops-pulse/operating-context";

const commonStart: NavItem[] = [
  { code: "ops_pulse", label: "Command Center", href: "/", icon: "#" },
  {
    code: "performance",
    label: "Performance",
    icon: "P",
    children: [
      { code: "performance", label: "Daily Performance", href: "/performance?view=daily" },
      { code: "performance_review", label: "Review Desk", href: "/performance?view=reviews" },
      { code: "performance", label: "Amazon SLS", href: "/performance?view=sls" }
    ]
  },
  {
    code: "capacity",
    label: "Capacity",
    icon: "A",
    children: [
      { code: "capacity_overview", label: "Overview", href: "/capacity" },
      { code: "capacity_associates", label: "Associate SPR", href: "/capacity/associates" },
      { code: "capacity_delivery", label: "Delivery Data", href: "/performance/shipments" },
      { code: "capacity_hiring", label: "Hiring Review", href: "/capacity/hiring" }
    ]
  },
  { code: "service_network", label: "Network Planning", href: "/service-network", icon: "N" },
  { code: "delivery_associates", label: "Workforce Register", href: "/work-force-register", icon: "+" },
  { code: "ops_rostering", label: "Rostering", href: "/rostering", icon: "S" }
];

const reports: NavItem = { code: "ops_reports", label: "Reports", href: "/reports", icon: "R" };
const attendanceReports: NavItem = { code: "ops_attendance_reports", label: "Attendance", href: "/attendance", icon: "T" };

const businessDocuments: NavItem = {
  code: "business_documents",
  label: "Business Docs",
  href: "/business-documents",
  icon: "D"
};

const payments: NavItem = {
  code: "payments",
  label: "Payments",
  icon: "₹",
  children: [
    { code: "advance_requests", label: "Advance Request", href: "/payments/advance-request" },
    { code: "payment_requests", label: "Payment Requests", href: "/payments/requests" },
    { code: "payment_approvals", label: "Approvals", href: "/payments/approvals" },
    { code: "payment_reports", label: "Payment Report", href: "/payments/report" }
  ]
};

const cps: NavItem = {
  code: "cps",
  label: "CPS",
  icon: "C",
  children: [
    { code: "cps_overview", label: "Overview", href: "/cps" },
    { code: "cps_stations", label: "Stations", href: "/cps?view=stations" },
    { code: "cps_shipments", label: "Shipments", href: "/cps?view=shipments" },
    { code: "cps_associates", label: "Associates", href: "/cps?view=associates" },
    { code: "cps_reports", label: "Reports", href: "/cps?view=reports" },
    { code: "imports", label: "Imports", href: "https://dashboard.dropxlogistics.com/imports" },
    { code: "cps_unmapped", label: "Unmapped IDs", href: "/cps?view=unmapped" },
    { code: "cps_inputs", label: "Inputs", href: "/cps?view=inputs" }
  ]
};

const administration: NavItem[] = [
  {
    code: "master_data",
    label: "Ops Masters",
    icon: "*",
    children: [
      { code: "cod_master", label: "COD Master", href: "/master/cod-master" },
      { code: "master_locations", label: "Station Master", href: "/master/location" },
      { code: "master_providers", label: "Client / Provider Master", href: "/master/providers" },
      { code: "master_models", label: "Operation Models", href: "/master/models" }
      ,{ code: "performance_master", label: "Performance Master", href: "/master/performance-targets" }
      ,{ code: "capacity_master", label: "Capacity Master", href: "/master/capacity" }
      ,{ code: "service_network_master", label: "Network Planning Master", href: "/master/service-network" }
    ]
  },
  {
    code: "users",
    label: "Users & Access",
    icon: "@",
    children: [
      { code: "users", label: "Ops Users & Scope", href: "/access" },
      { code: "users", label: "Designation Access", href: "/users?section=roles" }
    ]
  }
];

function modelOperations(mode: OperatingMode): NavItem {
  if (mode === "amazon_now") {
    return {
      code: "ops_pulse",
      label: "Live Operations",
      icon: "L",
      children: [
        { code: "ops_pulse", label: "Shift Control", href: "/?view=shift" },
        { code: "ops_pulse", label: "Hourly Performance", href: "/?view=hourly" },
        { code: "daily_submission", label: "Attendance & Reporting", href: "/daily-submission" },
        { code: "cod_reports", label: "Exceptions", href: "/cod/reports?client=amazon" }
      ]
    };
  }
  if (mode === "flipkart_odh_mdh") {
    return {
      code: "cod",
      label: "Operations",
      icon: "O",
      children: [
        { code: "cod_submission", label: "COD Submission", href: "/cod/submission?client=flipkart" },
        { code: "cod_reports", label: "COD Reports", href: "/cod/reports?client=flipkart" }
      ]
    };
  }
  return {
    code: "cod",
    label: "Operations",
    icon: "O",
    children: [
      { code: "cod_executive_reconciliation", label: "Executive Reconciliation", href: "/cod/executive-reconciliation?client=amazon" },
      { code: "cod_submission", label: "COD Submission", href: "/cod/submission?client=amazon" },
      { code: "cod_reports", label: "COD Reports", href: "/cod/reports?client=amazon" },
      { code: "cod_cash_in_associate", label: "Cash In Associate", href: "/cod/cash-in-associate?client=amazon" }
    ]
  };
}

const eddDashboard: NavItem = { code: "edd_dashboard", label: "Delivery Performance", href: "/edd", icon: "E" };

export function opsNavItemsForMode(mode: OperatingMode): NavItem[] {
  return [...commonStart, modelOperations(mode), eddDashboard, businessDocuments, payments, cps, fleetNavItem, attendanceReports, reports, ...administration];
}

export function firstAllowedOpsHref(authorization: AuthorizationContext) {
  if (isCompanyOwner(authorization)) return "/";
  const candidates = [
    ...opsNavItemsForMode("amazon_edsp"),
    modelOperations("amazon_now"),
    modelOperations("flipkart_odh_mdh")
  ];
  for (const item of candidates) {
    if (item.href && hasPermission(authorization, item.code, "access")) return item.href;
    const child = item.children?.find((entry) => entry.href && entry.code && hasPermission(authorization, entry.code, "access"));
    if (child?.href && child.href.startsWith("/")) return child.href;
  }
  return null;
}

export function normalizeOpsClient(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "amazon" || normalized === "flipkart" ? normalized : null;
}
