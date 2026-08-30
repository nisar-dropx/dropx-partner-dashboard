export const productDefinitions = [
  { code: "operations", name: "Operations", portalUrl: "https://ops.dropxlogistics.com" },
  { code: "people", name: "People", portalUrl: "https://people.dropxlogistics.com" },
  { code: "workforce", name: "Workforce", portalUrl: "https://workforce.dropxlogistics.com" },
  { code: "recruit", name: "Recruitment", portalUrl: "https://recruit.dropxlogistics.com" },
  { code: "finance", name: "Finance", portalUrl: "https://fin.dropxlogistics.com" },
  { code: "tech", name: "Tech", portalUrl: "https://admin-panel.dropxlogistics.com" }
] as const;

export type ProductCode = typeof productDefinitions[number]["code"];

export const productPageCodes: Record<ProductCode, readonly string[]> = {
  operations: [
    "ops_pulse", "performance", "capacity", "capacity_overview", "capacity_associates",
    "capacity_delivery", "capacity_hiring", "ops_reports", "ops_attendance_reports",
    "daily_submission", "cod", "cod_executive_reconciliation", "cod_submission",
    "cod_validation", "cod_reports", "cod_portal_checks", "cod_cash_in_associate",
    "edd_dashboard", "cps", "cps_overview", "cps_daily", "cps_monthly",
    "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports",
    "cps_inputs", "cps_unmapped", "service_network", "service_network_master",
    "master_locations", "master_providers", "master_models", "cod_master",
    "performance_master", "capacity_master", "imports", "fleet", "fleet_action_center",
    "fleet_vehicle_view", "fleet_date_view", "fleet_station_view", "fleet_tracking",
    "fleet_fuel_log", "fleet_live_gps", "fleet_maintenance", "fleet_reports", "users"
  ],
  people: [
    "people_all", "people_review", "people_exceptions", "employees", "contractors",
    "attendance_reports", "attendance_integrity", "inbox",
    "business_documents", "biometric_devices", "master_documents", "designations", "users"
  ],
  workforce: [
    "delivery_associates", "executive_id_onboarding", "provider_mapping", "people_review",
    "workforce_activity", "workforce_rate_cards", "workforce_earnings", "workforce_incentives",
    "workforce_adjustments", "workforce_payroll", "workforce_communications",
    "workforce_communications_app", "workforce_communications_whatsapp",
    "workforce_communications_history", "workforce_categories", "workforce_whatsapp",
    "designations", "vendors", "workers", "users"
  ],
  recruit: ["users"],
  finance: [
    "payments", "advance_requests", "expense_requests", "payment_requests", "payment_approvals",
    "payment_process", "workforce_payouts", "payment_reports", "payment_methods",
    "master_payment_banks", "master_payment_heads", "master_contacts", "payment_settings", "users"
  ],
  tech: [
    "company_master", "app_settings", "ai_connector", "amazon_connector", "developer_mode",
    "raw_punch_reports", "verification_api_reports", "event_log_reports", "biometric_devices", "users"
  ]
};

export const capabilityOwnership = [
  { capability: "Company setup, product-owner assignment, domains and platform audit", owner: "tech", consumer: "All products" },
  { capability: "Stations, regions, clusters and manager responsibility", owner: "operations", consumer: "People, Workforce, Recruit and Finance" },
  { capability: "Providers, models, operational IDs, fleet and production imports", owner: "operations", consumer: "Workforce and Finance" },
  { capability: "Departments, employee/contractor designations and HR policies", owner: "people", consumer: "Recruit and Finance" },
  { capability: "Delivery-network designations, engagement types and registration configuration", owner: "workforce", consumer: "Recruit, Operations and Finance" },
  { capability: "Jobs, sources, candidates, offers and recruitment workflow", owner: "recruit", consumer: "People and Workforce" },
  { capability: "Payment heads, methods, banks, approvals, processing and finance reports", owner: "finance", consumer: "Operations, People and Workforce" },
  { capability: "Integrations, developer controls and cross-product infrastructure", owner: "tech", consumer: "All products" }
] as const;

export function isProductCode(value: unknown): value is ProductCode {
  return productDefinitions.some((product) => product.code === value);
}

export function productCodeForHost(host: string): ProductCode | null {
  const normalized = host.split(":")[0].trim().toLowerCase();
  if (normalized === "ops.dropxlogistics.com" || normalized.startsWith("ops-")) return "operations";
  if (normalized === "people.dropxlogistics.com" || normalized.startsWith("people-")) return "people";
  if (normalized === "workforce.dropxlogistics.com" || normalized.startsWith("workforce-")) return "workforce";
  if (normalized === "recruit.dropxlogistics.com" || normalized.startsWith("recruit-")) return "recruit";
  if (["fin.dropxlogistics.com", "finance.dropxlogistics.com"].includes(normalized) || normalized.startsWith("fin-") || normalized.startsWith("finance-")) return "finance";
  if (["admin-panel.dropxlogistics.com", "dashboard.dropxlogistics.com"].includes(normalized)) return "tech";
  return null;
}
