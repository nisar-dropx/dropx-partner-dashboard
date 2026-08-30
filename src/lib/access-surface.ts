import { headers } from "next/headers";
import { isPeopleHostName } from "@/lib/people/surface";
import { financeAccessPageCodes, isFinanceHostName } from "@/lib/finance/surface";

export type AccessSurface = "dashboard" | "ops";
export type AdminAccessSurface = AccessSurface | "people" | "finance";

export const opsAccessPageCodes = [
  "ops_pulse",
  "performance",
  "capacity",
  "capacity_overview",
  "capacity_associates",
  "capacity_delivery",
  "capacity_hiring",
  "ops_reports",
  "ops_attendance_reports",
  "ops_location_mail",
  "daily_submission",
  "cod",
  "cod_executive_reconciliation",
  "cod_submission",
  "cod_validation",
  "cod_reports",
  "cod_portal_checks",
  "cod_cash_in_associate",
  "edd_dashboard",
  "cps",
  "cps_overview",
  "cps_daily",
  "cps_monthly",
  "cps_cost_breakup",
  "cps_stations",
  "cps_shipments",
  "cps_associates",
  "cps_reports",
  "cps_inputs",
  "cps_unmapped",
  "service_network",
  "service_network_master",
  "business_documents",
  "advance_requests",
  "expense_requests",
  "payment_requests",
  "payment_approvals",
  "payment_reports",
  "master_locations",
  "master_providers",
  "master_models",
  "master_documents",
  "cod_master",
  "performance_master",
  "capacity_master",
  "imports",
  "users",
  "fleet",
  "fleet_action_center",
  "fleet_vehicle_view",
  "fleet_date_view",
  "fleet_station_view",
  "fleet_tracking",
  "fleet_fuel_log",
  "fleet_live_gps",
  "fleet_maintenance",
  "fleet_reports"
] as const;

const opsPageCodes = new Set<string>(opsAccessPageCodes);

const sharedPageCodes = new Set([
  "imports",
  "advance_requests",
  "expense_requests",
  "payment_requests",
  "payment_approvals",
  "payment_reports",
  "master_locations",
  "master_providers",
  "master_models",
  "users",
  "fleet",
  "fleet_action_center",
  "fleet_vehicle_view",
  "fleet_date_view",
  "fleet_station_view",
  "fleet_tracking",
  "fleet_fuel_log",
  "fleet_live_gps",
  "fleet_maintenance",
  "fleet_reports"
]);

const peoplePageCodes = new Set([
  "people_all",
  "people_review",
  "people_exceptions",
  "employees",
  "reports",
  "attendance_reports",
  "attendance_integrity",
  "inbox",
  "imports",
  "notifications",
  "notifications_whatsapp",
  "notifications_history",
  "notifications_app",
  "users",
  "master_data",
  "designations",
  "biometric_devices",
  "master_imports",
  "app_settings"
]);

const financePageCodes = new Set<string>(financeAccessPageCodes);

export function currentAccessSurface(): AccessSurface {
  const host = (
    headers().get("x-forwarded-host") ??
    headers().get("host") ??
    ""
  ).split(":")[0].toLowerCase();
  return host === "ops.dropxlogistics.com" || host.startsWith("ops-") ? "ops" : "dashboard";
}

export function currentAdminAccessSurface(): AdminAccessSurface {
  const host = (
    headers().get("x-forwarded-host") ??
    headers().get("host") ??
    ""
  ).split(":")[0].toLowerCase();
  if (isFinanceHostName(host)) return "finance";
  if (isPeopleHostName(host)) return "people";
  return host === "ops.dropxlogistics.com" || host.startsWith("ops-") ? "ops" : "dashboard";
}

export function pageBelongsToSurface(code: string, surface: AdminAccessSurface) {
  if (surface === "finance") return financePageCodes.has(code);
  if (surface === "people") return peoplePageCodes.has(code);
  if (sharedPageCodes.has(code)) return true;
  return surface === "ops" ? opsPageCodes.has(code) : !opsPageCodes.has(code);
}

export function accessSurfaceLabel(surface: AdminAccessSurface) {
  return surface === "ops" ? "Ops" : surface === "people" ? "People" : surface === "finance" ? "Finance" : "Dashboard";
}
