import type { AuthorizationContext } from "@/lib/authorization";

export type NavItem = {
  children?: Array<{ code?: string; href?: string; label: string }>;
  code: string;
  href?: string;
  icon: string;
  label: string;
};

export const fleetNavItem: NavItem = {
  code: "fleet",
  label: "Fleet",
  icon: "F",
  children: [
    { code: "fleet_action_center", label: "Action Center", href: "/fleet?tab=action-center" },
    { code: "fleet_vehicle_view", label: "Vehicles", href: "/fleet?tab=vehicle-view" },
    { code: "fleet_date_view", label: "Documents", href: "/fleet?tab=date-view" },
    { code: "fleet_station_view", label: "Station View", href: "/fleet?tab=station-view" },
    { code: "fleet_tracking", label: "Tracking", href: "/fleet?tab=tracking" },
    { code: "fleet_fuel_log", label: "Fuel Log", href: "/fleet?tab=fuel-log" },
    { code: "fleet_live_gps", label: "Live GPS", href: "/fleet?tab=live-gps" },
    { code: "fleet_maintenance", label: "Maintenance", href: "/fleet?tab=maintenance" },
    { code: "fleet_reports", label: "Report", href: "/fleet?tab=report" }
  ]
};

export const navItems: NavItem[] = [
  { code: "dashboard", label: "Platform Control", href: "/", icon: "#" },
  {
    code: "company_master",
    label: "Masters",
    icon: "M",
    children: [
      { code: "company_master", label: "Platform & Access Owners", href: "/master/platform-access-owners" },
      { code: "master_locations", label: "Locations & Station Mail", href: "/master/location" }
    ]
  },
  {
    code: "reports",
    label: "Platform Audit",
    icon: "R",
    children: [
      { code: "raw_punch_reports", label: "Raw Punches", href: "/reports/raw-punches" },
      { code: "verification_api_reports", label: "Verification API", href: "/reports/verification-api" },
      { code: "event_log_reports", label: "Event Log", href: "/reports/event-log" }
    ]
  },
  { code: "trash", label: "Trash", href: "/trash", icon: "T" },
  {
    code: "notifications",
    label: "System Communications",
    icon: "N",
    children: [
      { code: "notifications_whatsapp", label: "WhatsApp", href: "/notifications/whatsapp" },
      { code: "notifications_history", label: "History", href: "/notifications/history" },
      { code: "notifications_app", label: "App Notifications", href: "/notifications/app" }
    ]
  },
  {
    code: "users",
    label: "Central Identity",
    icon: "@",
    children: [
      { code: "users", label: "Access Visibility", href: "/users?section=users" },
      { code: "workspace_identity", label: "Google Mail IDs & Mapping", href: "/settings/google-workspace" }
    ]
  },
  {
    code: "app_settings",
    label: "Tech Configuration",
    icon: "S",
    children: [
      { code: "app_settings", label: "General", href: "/settings" },
      { code: "app_settings", label: "App Notification", href: "/settings/app-notifications" },
      { code: "app_settings", label: "Verification APIs", href: "/settings/verification-apis" },
      { code: "biometric_devices", label: "Biometric Devices", href: "/master/biometric-devices" },
      { code: "app_settings", label: "Biometric Config", href: "/settings/biometric" },
      { code: "ai_connector", label: "AI Connector", href: "/settings/ai" },
      { code: "amazon_connector", label: "Amazon Connector", href: "/settings/amazon" },
      { code: "developer_mode", label: "Developer Mode", href: "/developer" }
    ]
  }
];

function canAccess(authorization: AuthorizationContext, code?: string) {
  if (!code) return true;
  const permission = authorization.permissions[code];
  return Boolean(permission?.canView || permission?.canAdd || permission?.canEdit);
}

export function firstAllowedHref(authorization: AuthorizationContext) {
  for (const item of navItems) {
    if (item.href && canAccess(authorization, item.code)) return item.href;
    const child = item.children?.find((entry) => entry.href && canAccess(authorization, entry.code));
    if (child?.href) return child.href;
  }
  return null;
}
