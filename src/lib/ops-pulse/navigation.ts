import { fleetNavItem, type NavItem } from "@/lib/app-navigation";
import { hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import type { OperatingMode } from "@/lib/ops-pulse/operating-context";
import { canAccessDailyCodPending } from "@/lib/ops-pulse/cod-pending-access";

export const shiftAttendanceNavItem: NavItem = { code: "ops_rostering", label: "Shift Attendance", href: "/ops-pulse?view=manpower", icon: "S" };

const commonStart: NavItem[] = [
  { code: "ops_pulse", label: "Command Center", href: "/", icon: "#" },
  shiftAttendanceNavItem,
  {
    code: "performance",
    label: "Performance",
    permissionCodes: ["performance_review_cluster_filter"],
    icon: "P",
    children: [
      { code: "performance", label: "Daily Performance", href: "/performance?view=daily" },
      { code: "performance_review", label: "Review Desk", href: "/performance?view=reviews" },
      { code: "performance_review_status", label: "Review Status", href: "/performance/review-status" },
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
      { code: "capacity_associates", label: "Distance & Fuel", href: "/capacity/distance" },
      { code: "capacity_hiring", label: "Hiring Review", href: "/capacity/hiring" }
    ]
  },
  {
    code: "workforce",
    label: "Workforce",
    icon: "+",
    children: [
      { code: "delivery_associates", label: "Workforce Register", href: "/work-force-register" },
      { code: "ops_provider_mapping", label: "ID Mapping", href: "/provider-id-mapping" },
      { code: "ops_workforce_payouts", label: "Workforce Payouts", href: "/payments/workforce-payouts" },
      { code: "ops_workforce_payout_disputes", label: "Payout Disputes", href: "/payments/disputes" },
      { code: "ops_workforce_advances", label: "Workforce Advance Register", href: "/payments/workforce-advances" },
      { code: "ops_rostering", label: "Rostering", href: "/rostering" }
    ]
  }
];

const reports: NavItem = { code: "ops_reports", label: "Reports", href: "/reports", icon: "R" };
const attendanceReports: NavItem = { code: "ops_attendance_reports", label: "Team Ops", permissionCodes: ["ops_loss_recovered"], icon: "T", children: [
  { code: "ops_my_team", label: "My Team & Org", href: "/attendance/my-team" },
  { code: "ops_attendance_reports", label: "Attendance Reports", href: "/attendance" },
  { code: "ops_unplanned_leaves", label: "Unplanned Leaves", href: "/attendance/unplanned-leaves" },
  { code: "ops_offboarding_checklist", label: "Offboarding", href: "/attendance/offboarding" },
  { code: "ops_salary_hold", label: "People Salary Hold", href: "/attendance/salary-hold" },
  { code: "ops_salary_hold", label: "Workforce Payment Holds", href: "/attendance/workforce-holds" },
  { code: "ops_workforce_mileage", label: "DA distance pilot", href: "/attendance/da-distance" },
  { code: "ops_workforce_mileage", label: "Mileage Claims", href: "/attendance/workforce-mileage" },
  { code: "ops_losses", label: "Losses", href: "/team-ops/losses" }
] };

const businessDocuments: NavItem = {
  code: "business_documents",
  label: "Business Docs",
  href: "/business-documents",
  icon: "D"
};

const payments: NavItem = {
  code: "payments",
  label: "Payments",
  permissionCodes: ["expense_requests"],
  icon: "₹",
  children: [
    { code: "advance_requests", label: "Advance Request", href: "/payments/advance-request" },
    { code: "payment_process", label: "Pay Advances", href: "/payments/pay-advances" },
    { code: "payment_requests", label: "Payment Requests", href: "/payments/requests" },
    { code: "payment_approvals", label: "Approvals", href: "/payments/approvals" },
    { code: "payment_reports", label: "Payment Report", href: "/payments/report" }
  ]
};

const cps: NavItem = {
  code: "cps",
  label: "CPS",
  permissionCodes: ["cps_daily", "cps_monthly", "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports", "imports", "cps_unmapped"],
  icon: "C",
  children: [
    { code: "cps_overview", label: "Cost overview", href: "/cps" },
    { code: "cps_overview", label: "Adhoc Van & DA", href: "/cps/adhoc-activity" }

  ]
};

const administration: NavItem[] = [
  {code:'ops_notification_settings',label:'Settings',icon:'*',children:[
    {code:'ops_notification_settings',label:'Notifications',href:'/settings/notifications'},
    {code:'payment_settings',label:'Payout Dispute Workflow',href:'/settings/payout-disputes'}
  ]},
  {
    code: "master_data",
    label: "Ops Masters",
    icon: "*",
    children: [
      { code: "cps_inputs", label: "CPS Master", href: "/master/cps" },
      { code: "ops_workforce_mileage", label: "DA distance pilot", href: "/attendance/da-distance" },
      { code: "cps_inputs", label: "Advertising Master", href: "/master/advertising" },
      { code: "cod_master", label: "COD Pickup Master", href: "/master/cod-master" },
      { code: "ops_loss_master", label: "Loss Recovery Master", href: "/master/loss-recovery" },
      { code: "station_audit_master", label: "Audit Master", href: "/master/audits" },
      { code: "master_locations", label: "Station Master", href: "/master/location" },
      { code: "master_providers", label: "Client / Provider Master", href: "/master/providers" },
      { code: "master_models", label: "Operation Models", href: "/master/models" }
      ,{ code: "delivery_associates", label: "Client ID Master", href: "/master/client-id" }
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
        { code: "station_audits", label: "Station Audits", href: "/audits" },
        { code: "cod_reports", label: "Exceptions", href: "/cod/reports?client=amazon" }
      ]
    };
  }
  if (mode === "flipkart_odh_mdh") {
    return {
      code: "cod",
      label: "Operations",
      permissionCodes: ["daily_submission", "cod_validation", "cod_portal_checks", "station_edd"],
      icon: "O",
      children: [
        networkPlanning,
        eddDashboard,
        { code: "cod_submission", label: "COD Submission", href: "/cod/submission?client=flipkart" },
        { code: "station_audits", label: "Station Audits", href: "/audits" },
        { code: "cod_reports", label: "COD Reports", href: "/cod/reports?client=flipkart" },
        { code: "cod_reports", label: "COD Slip Review", href: "/cod/pending" }
      ]
    };
  }
  return {
    code: "cod",
    label: "Operations",
    permissionCodes: ["daily_submission", "cod_validation", "cod_portal_checks", "station_edd"],
    icon: "O",
    children: [
      networkPlanning,
      eddDashboard,
      { code: "cod_executive_reconciliation", label: "Executive Reconciliation", href: "/cod/executive-reconciliation?client=amazon" },
      { code: "cod_submission", label: "COD Submission", href: "/cod/submission?client=amazon" },
      { code: "cod_reports", label: "COD Reports", href: "/cod/reports?client=amazon" },
      { code: "cod_cash_in_associate", label: "Cash In Associate", href: "/cod/cash-in-associate?client=amazon" },
      { code: "station_audits", label: "Station Audits", href: "/audits" },
      { code: "cod_reports", label: "COD Slip Review", href: "/cod/pending" },
      { code: "cod_reports", label: "COD Status", href: "/cod/status" }
    ]
  };
}

const networkPlanning = { code: "service_network", label: "Network Planning", href: "/service-network" };
const eddDashboard = { code: "edd_dashboard", label: "Delivery Performance", href: "/edd/flash" };

/** Unfiltered menu catalogue shared by the sidebar and designation editor. */
export function opsNavCatalogForMode(mode: OperatingMode): NavItem[] {
  if (mode === "amazon_now") return [
    {code:'ops_pulse',label:'Command Center',href:'/',icon:'#'},
    shiftAttendanceNavItem,
    {code:'ops_rostering',label:'Rostering',href:'/rostering',icon:'S'},
    {code:'store_audits',label:'Store Audits',href:'/store-audits',icon:'A'},
    {
      code: "si_handover",
      label: "Activities & Handover",
      icon: "▶",
      children: [
        {
          code: "si_handover",
          label: "Shift operations",
          href: "/si-handover?view=start",
        },
        {
          code: "store_ops",
          label: "Store operations",
          href: "/store-ops?view=start",
        },
        {
          code: "si_handover",
          label: "Shift report",
          href: "/si-handover/report?tab=shift",
        },
        {
          code: "store_ops",
          label: "Store report",
          href: "/si-handover/report?tab=store",
        },
      ],
    },
    {
      code: "performance",
      label: "Performance",
      icon: "P",
      children: [
        { code: "performance_review", label: "Review Desk", href: "/performance?view=reviews" },
        { code: "performance_review_status", label: "Review Status", href: "/performance/review-status" }
      ]
    },
    {code:'ops_report_bot',label:'Report Bot',href:'/report-bot',icon:'W'},
    businessDocuments,payments,
    {code:'cpu_overview',label:'CPU · Cost per unit',href:'/cpu',icon:'C'},reports,
    {...administration[0],children:[...(administration[0].children??[]),{code:'ops_report_bot',label:'Report Bot setup',href:'/report-bot/setup'}]},
    {code:'master_data',label:'Ops Masters',icon:'*',children:[
      {code:'cps_inputs',label:'CPU Master & units',href:'/cpu/master'},
      {code:'store_audit_master',label:'Audit Master',href:'/master/store-audits'},
      {code:'si_handover_master',label:'Shift operations Master',href:'/master/si-handover'},
      {code:'store_ops_master',label:'Store operations Master',href:'/master/store-ops'},
      {code:'master_locations',label:'Location Master',href:'/master/location'},
      {code:'master_providers',label:'Client / Provider Master',href:'/master/providers'},
      {code:'master_models',label:'Operation Models',href:'/master/models'}
    ]},administration[2]
  ];
  const opsFleet: NavItem = {
    ...fleetNavItem,
    children: [
      {code:'fleet_da_mapping',label:'Vehicle DA mapping',href:'/fleet/da-mapping'},
      ...(fleetNavItem.children ?? [])
    ]
  };
  return [...commonStart, modelOperations(mode), businessDocuments, payments, cps, opsFleet, attendanceReports, reports, ...administration];
}

export function opsNavItemsForMode(mode: OperatingMode, authorization?: AuthorizationContext): NavItem[] {
  const items = opsNavCatalogForMode(mode);
  return items.map(item=>item.children?{...item,children:item.children.filter(child=>child.href!=='/cod/pending'||Boolean(authorization&&canAccessDailyCodPending(authorization)))}:item);
}

export function firstAllowedOpsHref(authorization: AuthorizationContext) {
  if (isCompanyOwner(authorization)) return "/";
  const candidates = [
    ...opsNavItemsForMode("amazon_edsp", authorization),
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
