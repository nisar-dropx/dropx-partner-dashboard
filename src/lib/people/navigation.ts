import type { NavItem } from "@/lib/app-navigation";
import { isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";

export const peoplePrimaryPageCodes = [
  "people_all",
  "people_review",
  "people_exceptions",
  "employees",
  "attendance_reports",
  "attendance_integrity"
] as const;

export const peopleNavItems: NavItem[] = [
  {
    code: "people_all",
    label: "People",
    icon: "P",
    children: [
      { code: "people_all", label: "All Employees", href: "/people/all" },
      { code: "employees", label: "Employees", href: "/employees" },
      { code: "people_review", label: "Under Review", href: "/people/review" },
      { code: "people_exceptions", label: "Exceptions", href: "/people/exceptions" }
    ]
  },
  {
    code: "reports",
    label: "Attendance",
    icon: "A",
    children: [
      { code: "attendance_reports", label: "Attendance Reports", href: "/attendance" },
      { code: "attendance_integrity", label: "Attendance Integrity", href: "/attendance/integrity" }
    ]
  },
  { code: "inbox", label: "Inbox", href: "/inbox", icon: "I" },
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
      { code: "designations", label: "HR Designations", href: "/master/designations" },
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
      { code: "app_settings", label: "App Notification", href: "/settings/app-notifications" }
    ]
  }
];

const peoplePageCodes = new Set(peopleNavItems.flatMap((item) => [
  item.code,
  ...(item.children ?? []).flatMap((child) => child.code ? [child.code] : [])
]));

export function isPeoplePortalPageCode(code: string) {
  return peoplePageCodes.has(code);
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
  return null;
}
