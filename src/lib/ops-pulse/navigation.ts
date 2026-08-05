import { fleetNavItem, type NavItem } from "@/lib/app-navigation";
import type { OperatingMode } from "@/lib/ops-pulse/operating-context";

const commonStart: NavItem[] = [
  { code: "ops_pulse", label: "Command Center", href: "/", icon: "#" },
  { code: "cod_reports", label: "Performance", href: "/performance", icon: "P" },
  { code: "cps_associates", label: "Capacity", href: "/capacity", icon: "A" },
  { code: "service_network", label: "Service Network", href: "/service-network", icon: "S" },
  { code: "delivery_associates", label: "Workforce Onboarding", href: "/field-executive", icon: "+" }
];

const reports: NavItem = { code: "cod_reports", label: "Reports", href: "/reports", icon: "R" };

const payments: NavItem = {
  code: "payments",
  label: "Payments",
  icon: "₹",
  children: [
    { code: "payment_requests", label: "Payment Requests", href: "/payments/requests" },
    { code: "payment_approvals", label: "Approvals", href: "/payments/approvals" }
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
      ,{ code: "cod_master", label: "Performance Master", href: "/master/performance-targets" }
      ,{ code: "cod_master", label: "Capacity Master", href: "/master/capacity" }
      ,{ code: "service_network_master", label: "Service Network Master", href: "/master/service-network" }
    ]
  },
  {
    code: "users",
    label: "Users & Access",
    icon: "@",
    children: [
      { code: "users", label: "Ops Users & Scope", href: "/access" },
      { code: "users", label: "Manage Roles", href: "/users?section=roles" }
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
        { code: "cod_reports", label: "Exceptions", href: "/cod/reports?client=amazon" },
        { code: "cod_reports", label: "Performance Reports", href: "/reports/amazon" }
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
        { code: "cod_validation", label: "Deposit Validation", href: "/cod/validation?client=flipkart" },
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
      { code: "cod_validation", label: "Validation & Closure", href: "/cod/validation?client=amazon" },
      { code: "cod_portal_checks", label: "SCC Portal Checks", href: "/cod/portal-checks" },
      { code: "cod_reports", label: "COD Reports", href: "/cod/reports?client=amazon" }
      ,{ code: "cod_reports", label: "Performance Reports", href: "/reports/amazon" }
    ]
  };
}

export function opsNavItemsForMode(mode: OperatingMode): NavItem[] {
  const start = mode === "amazon_now" ? commonStart.filter((item) => !["Capacity", "Service Network"].includes(item.label)) : commonStart;
  return [...start, modelOperations(mode), payments, cps, fleetNavItem, reports, ...administration];
}

export function normalizeOpsClient(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "amazon" || normalized === "flipkart" ? normalized : null;
}
