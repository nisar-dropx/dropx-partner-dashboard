import type { NavItem } from "@/lib/app-navigation";
import { isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { workforceCategoryPagePrefix } from "@/lib/dynamic-workforce";

export const peoplePrimaryPageCodes = [
  "people_all",
  "people_review",
  "people_exceptions",
  "employees",
  "delivery_associates",
  "contractors",
  "vendors",
  "workers",
  "attendance_reports",
  "attendance_integrity",
  "raw_punch_reports"
] as const;

export const peopleNavItems: NavItem[] = [
  {
    code: "people_all",
    label: "People",
    icon: "P",
    children: [
      { code: "people_all", label: "All People", href: "/people/all" },
      { code: "employees", label: "Employees", href: "/employees" },
      { code: "delivery_associates", label: "Field Executives", href: "/field-executive" },
      { code: "contractors", label: "Independent Contractors", href: "/contractors" },
      { code: "vendors", label: "Vendors", href: "/vendors" },
      { code: "workers", label: "Workers", href: "/workers" },
      { code: "people_review", label: "Under Review", href: "/people/review" },
      { code: "people_exceptions", label: "Exceptions", href: "/people/exceptions" },
      { code: "people_review", label: "Workforce Lifecycle", href: "/people/workforce-lifecycle" }
    ]
  },
  {
    code: "reports",
    label: "Attendance",
    icon: "A",
    children: [
      { code: "attendance_reports", label: "Attendance Reports", href: "/attendance" },
      { code: "attendance_integrity", label: "Attendance Integrity", href: "/attendance/integrity" },
      { code: "raw_punch_reports", label: "Raw Punches", href: "/reports/raw-punches" },
      { code: "verification_api_reports", label: "Verification API", href: "/reports/verification-api" },
      { code: "event_log_reports", label: "Event Log", href: "/reports/event-log" }
    ]
  },
  { code: "inbox", label: "Inbox", href: "/inbox", icon: "I" },
  { code: "business_documents", label: "Business Docs", href: "/business-documents", icon: "D" },
  {
    code: "payments",
    label: "Payments",
    icon: "₹",
    children: [
      { code: "advance_requests", label: "Advance Request", href: "/payments/advance-request" },
      { code: "expense_requests", label: "Expense Request", href: "/payments/expense-request" },
      { code: "payment_requests", label: "Payment Requests", href: "/payments/requests" },
      { code: "payment_approvals", label: "Approvals", href: "/payments/approvals" },
      { code: "payment_process", label: "Process", href: "/payments/process" },
      { code: "workforce_payouts", label: "Workforce Payouts", href: "/payments/workforce-payouts" },
      { code: "payment_reports", label: "Report", href: "/payments/report" }
    ]
  },
  { code: "imports", label: "Report Imports", href: "/imports", icon: "^" },
  {
    code: "notifications",
    label: "Notifications",
    icon: "N",
    children: [
      { code: "notifications_whatsapp", label: "WhatsApp", href: "/notifications/whatsapp" },
      { code: "notifications_history", label: "History", href: "/notifications/history" },
      { code: "notifications_app", label: "App Notifications", href: "/notifications/app" }
    ]
  },
  {
    code: "users",
    label: "Users & Access",
    icon: "@",
    children: [
      { code: "users", label: "Users", href: "/users?section=users" },
      { code: "users", label: "User Roles", href: "/users?section=roles" },
      { code: "users", label: "Positions & Delegation", href: "/users/positions" }
    ]
  },
  {
    code: "master_data",
    label: "People Masters",
    icon: "*",
    children: [
      { code: "master_locations", label: "Locations", href: "/master/location" },
      { code: "master_providers", label: "Providers", href: "/master/providers" },
      { code: "payment_methods", label: "Payment Methods", href: "/master/payment-methods" },
      { code: "master_payment_banks", label: "Payment Banks", href: "/master/payment-banks" },
      { code: "master_payment_heads", label: "Payment Heads", href: "/master/payment-heads" },
      { code: "master_contacts", label: "Contacts", href: "/master/contacts" },
      { code: "workforce_categories", label: "Workforce Categories", href: "/master/workforce-categories" },
      { code: "workforce_whatsapp", label: "Workforce WhatsApp", href: "/master/workforce-whatsapp" },
      { code: "designations", label: "Designations", href: "/master/designations" },
      { code: "biometric_devices", label: "Device Master", href: "/master/biometric-devices" },
      { code: "master_documents", label: "Documents", href: "/master/documents" },
      { code: "master_imports", label: "Import Master", href: "/master/imports" }
    ]
  },
  {
    code: "app_settings",
    label: "Settings",
    icon: "S",
    children: [
      { code: "app_settings", label: "General", href: "/settings" },
      { code: "app_settings", label: "DropX ID Generation", href: "/settings/dropx-id-generation?type=dropx_id" },
      { code: "app_settings", label: "Biometric ID Generation", href: "/settings/dropx-id-generation?type=biometric_id" },
      { code: "app_settings", label: "App Notification", href: "/settings/app-notifications" },
      { code: "app_settings", label: "Verification APIs", href: "/settings/verification-apis" },
      { code: "app_settings", label: "Biometric Config", href: "/settings/biometric" }
    ]
  }
];

const peoplePageCodes = new Set(peopleNavItems.flatMap((item) => [
  item.code,
  ...(item.children ?? []).flatMap((child) => child.code ? [child.code] : [])
]));

export function isPeoplePortalPageCode(code: string) {
  return peoplePageCodes.has(code) || code.startsWith(workforceCategoryPagePrefix);
}

function canAccess(authorization: AuthorizationContext, code?: string) {
  if (!code) return true;
  const permission = authorization.permissions[code];
  return Boolean(permission?.canView || permission?.canAdd || permission?.canEdit);
}

export function hasPeoplePortalAccess(authorization: AuthorizationContext) {
  if (isCompanyOwner(authorization)) return true;
  return Object.entries(authorization.permissions).some(([code, permission]) => (
    isPeoplePortalPageCode(code) &&
    Boolean(permission.canView || permission.canAdd || permission.canEdit)
  ));
}

export function firstAllowedPeopleHref(authorization: AuthorizationContext) {
  for (const item of peopleNavItems) {
    if (item.href && canAccess(authorization, item.code)) return item.href;
    const child = item.children?.find((entry) => entry.href && canAccess(authorization, entry.code));
    if (child?.href) return child.href;
  }
  const dynamicCategoryCode = Object.keys(authorization.permissions).find((code) => (
    code.startsWith(workforceCategoryPagePrefix) && canAccess(authorization, code)
  ));
  return dynamicCategoryCode
    ? `/people/category/${encodeURIComponent(dynamicCategoryCode.slice(workforceCategoryPagePrefix.length))}`
    : null;
}
