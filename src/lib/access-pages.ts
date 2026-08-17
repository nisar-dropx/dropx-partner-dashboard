import type { SupabaseClient } from "@supabase/supabase-js";
import { workforceCategoryPageCode, workforceCategoryPagePrefix } from "@/lib/dynamic-workforce";

export const accessPages = [
  { code: "dashboard", name: "Command Center", sort_order: 10 },
  { code: "leads", name: "Leads", sort_order: 30 },
  { code: "leads_dashboard", name: "Lead Dashboard", sort_order: 31 },
  { code: "leads_all", name: "All Leads", sort_order: 32 },
  { code: "leads_followups", name: "Follow-ups", sort_order: 33 },
  { code: "leads_interviews", name: "Interviews", sort_order: 34 },
  { code: "leads_reports", name: "Lead Reports", sort_order: 35 },
  { code: "leads_ads", name: "All Ads", sort_order: 36 },
  { code: "leads_sop", name: "Ad SOP", sort_order: 37 },
  { code: "people_all", name: "All People", sort_order: 20 },
  { code: "people_review", name: "Profile Review", sort_order: 29 },
  { code: "people_exceptions", name: "People Exceptions", sort_order: 30 },
  { code: "executive_id_onboarding", name: "Executive ID Onboarding", sort_order: 30 },
  { code: "provider_mapping", name: "ID Mapping", sort_order: 40 },
  { code: "fleet", name: "Fleet", sort_order: 45 },
  { code: "fleet_action_center", name: "Action Center", sort_order: 46 },
  { code: "fleet_vehicle_view", name: "Vehicles", sort_order: 47 },
  { code: "fleet_date_view", name: "Documents", sort_order: 48 },
  { code: "fleet_station_view", name: "Station View", sort_order: 50 },
  { code: "fleet_tracking", name: "Tracking", sort_order: 51 },
  { code: "fleet_fuel_log", name: "Fuel Log", sort_order: 52 },
  { code: "fleet_live_gps", name: "Live GPS", sort_order: 53 },
  { code: "fleet_maintenance", name: "Maintenance", sort_order: 54 },
  { code: "fleet_reports", name: "Fleet Report", sort_order: 55 },
  { code: "mapping", name: "Mapping", sort_order: 50 },
  { code: "rate_cards", name: "Rate Cards", sort_order: 60 },
  { code: "imports", name: "Report Imports", sort_order: 70 },
  { code: "ops_pulse", name: "Ops Pulse", sort_order: 84 },
  { code: "performance", name: "Performance", sort_order: 84 },
  { code: "capacity", name: "Capacity", sort_order: 84 },
  { code: "capacity_overview", name: "Capacity Overview", sort_order: 84 },
  { code: "capacity_associates", name: "Associate SPR", sort_order: 84 },
  { code: "capacity_delivery", name: "Delivery Data", sort_order: 84 },
  { code: "capacity_hiring", name: "Hiring Review", sort_order: 84 },
  { code: "ops_reports", name: "Ops Reports", sort_order: 84 },
  { code: "service_network", name: "Network Planning", sort_order: 92 },
  { code: "service_network_master", name: "Network Planning Master", sort_order: 93 },
  { code: "daily_submission", name: "Daily Submission", sort_order: 85 },
  { code: "cod", name: "COD", sort_order: 86 },
  { code: "cod_executive_reconciliation", name: "Executive Reconciliation", sort_order: 87 },
  { code: "cod_submission", name: "COD Submission", sort_order: 88 },
  { code: "cod_validation", name: "COD Validation", sort_order: 89 },
  { code: "cod_reports", name: "COD Reports", sort_order: 90 },
  { code: "cod_portal_checks", name: "COD Portal Checks", sort_order: 91 },
  { code: "cod_cash_in_associate", name: "Cash In Associate", sort_order: 94 },
  { code: "cps", name: "CPS", sort_order: 73 },
  { code: "cps_overview", name: "CPS Overview", sort_order: 74 },
  { code: "cps_daily", name: "Daily CPS", sort_order: 75 },
  { code: "cps_monthly", name: "Monthly CPS", sort_order: 76 },
  { code: "cps_cost_breakup", name: "CPS Cost Breakup", sort_order: 77 },
  { code: "cps_stations", name: "CPS Stations", sort_order: 78 },
  { code: "cps_shipments", name: "CPS Shipments", sort_order: 79 },
  { code: "cps_associates", name: "CPS Associates", sort_order: 80 },
  { code: "cps_reports", name: "CPS Reports", sort_order: 81 },
  { code: "cps_inputs", name: "CPS Inputs", sort_order: 82 },
  { code: "cps_unmapped", name: "CPS Unmapped IDs", sort_order: 83 },
  { code: "report_upload", name: "Report Upload", sort_order: 80 },
  { code: "earnings", name: "Earnings Review", sort_order: 90 },
  { code: "exceptions", name: "Exceptions", sort_order: 100 },
  { code: "inbox", name: "Inbox", sort_order: 102 },
  { code: "business_documents", name: "Business Documents", sort_order: 103 },
  { code: "payments", name: "Payments", sort_order: 104 },
  { code: "expense_requests", name: "Expense Request", sort_order: 105 },
  { code: "payment_requests", name: "Payment Requests", sort_order: 106 },
  { code: "payment_approvals", name: "Payment Approvals", sort_order: 107 },
  { code: "payment_process", name: "Payment Process", sort_order: 108 },
  { code: "payment_reports", name: "Payment Report", sort_order: 109 },
  { code: "trash", name: "Trash", sort_order: 107 },
  { code: "notifications_whatsapp", name: "WhatsApp Notifications", sort_order: 108 },
  { code: "notifications_history", name: "Notification History", sort_order: 109 },
  { code: "notifications_email", name: "Email Notifications", sort_order: 110 },
  { code: "notifications_app", name: "App Notifications", sort_order: 111 },
  { code: "users", name: "Users & Access", sort_order: 112 },
  { code: "master_locations", name: "Locations", sort_order: 120 },
  { code: "master_providers", name: "Providers", sort_order: 121 },
  { code: "master_models", name: "Models", sort_order: 122 },
  { code: "payment_methods", name: "Payment Methods", sort_order: 123 },
  { code: "master_payment_banks", name: "Payment Banks", sort_order: 124 },
  { code: "master_payment_heads", name: "Payment Heads", sort_order: 125 },
  { code: "master_contacts", name: "Contacts", sort_order: 126 },
  { code: "workforce_categories", name: "Workforce Categories", sort_order: 126 },
  { code: "workforce_whatsapp", name: "Workforce WhatsApp", sort_order: 127 },
  { code: "designations", name: "Designations", sort_order: 128 },
  { code: "biometric_devices", name: "Device Master", sort_order: 129 },
  { code: "cod_master", name: "COD Master", sort_order: 130 },
  { code: "performance_master", name: "Performance Master", sort_order: 130 },
  { code: "capacity_master", name: "Capacity Master", sort_order: 130 },
  { code: "master_documents", name: "Documents", sort_order: 131 },
  { code: "master_imports", name: "Import Master", sort_order: 132 },
  { code: "reports", name: "Reports", sort_order: 130 },
  { code: "attendance_reports", name: "Attendance Reports", sort_order: 131 },
  { code: "raw_punch_reports", name: "Raw Punches", sort_order: 132 },
  { code: "verification_api_reports", name: "Verification API Reports", sort_order: 133 },
  { code: "event_log_reports", name: "Event Log", sort_order: 134 },
  { code: "payment_settings", name: "Payment Settings", sort_order: 131 },
  { code: "app_settings", name: "Settings", sort_order: 132 },
  { code: "ai_connector", name: "AI Connector", sort_order: 133 },
  { code: "amazon_connector", name: "Amazon Connector", sort_order: 134 },
  { code: "developer_mode", name: "Developer Mode", sort_order: 135 }
];

type PageRow = {
  id: string;
  code: string;
  name?: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
};
type WorkforceCategoryRow = { code: string; name: string };
type PermissionRow = {
  role_id: string;
  page_id: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
};

const fullAccess = { can_view: true, can_add: true, can_edit: true };

function isDuplicatePageCodeError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("app_pages_code_key") ||
    (message.includes("duplicate key") && message.includes("app_pages") && message.includes("code"));
}

function isDuplicateRoleCodeError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("user_roles_code_key") ||
    (message.includes("duplicate key") && message.includes("user_roles") && message.includes("code"));
}

function isDuplicatePermissionError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("role_page_permissions_pkey") ||
    (message.includes("duplicate key") && message.includes("role_page_permissions"));
}

async function getFirstRoleByCode(
  supabase: SupabaseClient,
  companyId: string,
  code: string
): Promise<{ id: string } | null> {
    const { data, error } = await supabase
      .from("user_roles")
      .select("id")
      .eq("company_id", companyId)
      .eq("code", code)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    if (data?.[0]) return data[0];

    const legacyResult = await supabase
      .from("user_roles")
      .select("id")
      .eq("code", code)
      .order("created_at", { ascending: true })
      .limit(1);
    if (legacyResult.error) throw new Error(legacyResult.error.message);
    return legacyResult.data?.[0] ?? null;
}

async function getPagesByCodes(supabase: SupabaseClient, companyId: string, codes: string[]) {
  const { data, error } = await supabase
    .from("app_pages")
    .select("id, code, is_active")
    .eq("company_id", companyId)
    .in("code", codes);
  if (error) throw new Error(error.message);

  const found = new Map((data ?? []).map((page: PageRow) => [page.code, page]));
  const missingCodes = codes.filter((code) => !found.has(code));
  if (!missingCodes.length) return found;

  const { data: legacyData, error: legacyError } = await supabase
    .from("app_pages")
    .select("id, code, is_active")
    .in("code", missingCodes)
    .is("company_id", null);
  if (legacyError) throw new Error(legacyError.message);
  (legacyData ?? []).forEach((page: PageRow) => {
    if (!found.has(page.code)) found.set(page.code, page);
  });

  return found;
}

async function upsertPermissionRows(supabase: SupabaseClient, companyId: string, rows: PermissionRow[]) {
  if (!rows.length) return;

  const roleIds = Array.from(new Set(rows.map((row) => row.role_id)));
  const pageIds = Array.from(new Set(rows.map((row) => row.page_id)));
  const { data: existing, error: existingError } = await supabase
    .from("role_page_permissions")
    .select("role_id, page_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .in("role_id", roleIds)
    .in("page_id", pageIds);
  if (existingError) throw new Error(existingError.message);

  const existingByKey = new Map((existing ?? []).map((row) => [`${row.role_id}:${row.page_id}`, row]));
  const insertRows = rows
    .filter((row) => !existingByKey.has(`${row.role_id}:${row.page_id}`))
    .map((row) => ({ company_id: companyId, ...row }));
  const updateRows = rows.filter((row) => {
    const existingRow = existingByKey.get(`${row.role_id}:${row.page_id}`);
    return existingRow && (
      Boolean(existingRow.can_view) !== row.can_view ||
      Boolean(existingRow.can_add) !== row.can_add ||
      Boolean(existingRow.can_edit) !== row.can_edit
    );
  });

  if (insertRows.length) {
    const { error } = await supabase.from("role_page_permissions").insert(insertRows);
    if (error) {
      if (!isDuplicatePermissionError(error)) throw new Error(error.message);

      await Promise.all(insertRows.map(async (row) => {
        const { error: updateError } = await supabase
          .from("role_page_permissions")
          .update({ can_view: row.can_view, can_add: row.can_add, can_edit: row.can_edit, company_id: companyId })
          .eq("role_id", row.role_id)
          .eq("page_id", row.page_id);
        if (updateError) throw new Error(updateError.message);
      }));
    }
  }

  await Promise.all(updateRows.map(async (row) => {
    const { error } = await supabase
      .from("role_page_permissions")
      .update({ can_view: row.can_view, can_add: row.can_add, can_edit: row.can_edit })
      .eq("company_id", companyId)
      .eq("role_id", row.role_id)
      .eq("page_id", row.page_id);
    if (error) throw new Error(error.message);
  }));
}

async function retirePage(supabase: SupabaseClient, companyId: string, pageId: string) {
  const { error } = await supabase
    .from("app_pages")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("id", pageId);
  if (error) throw new Error(error.message);
}

async function mergeRetiredPagePermissions(
  supabase: SupabaseClient,
  companyId: string,
  sourceCode: string,
  targetCode: string
) {
  const pages = await getPagesByCodes(supabase, companyId, [sourceCode, targetCode]);
  const sourcePage = pages.get(sourceCode);
  const targetPage = pages.get(targetCode);
  if (!sourcePage || !targetPage) return;

  const { data: grants, error } = await supabase
    .from("role_page_permissions")
    .select("role_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .in("page_id", [sourcePage.id, targetPage.id]);
  if (error) throw new Error(error.message);

  const byRole = new Map<string, Omit<PermissionRow, "role_id" | "page_id">>();
  (grants ?? []).forEach((grant) => {
    const current = byRole.get(grant.role_id) ?? { can_view: false, can_add: false, can_edit: false };
    byRole.set(grant.role_id, {
      can_view: current.can_view || grant.can_view || grant.can_edit,
      can_add: current.can_add || grant.can_add,
      can_edit: current.can_edit || grant.can_edit
    });
  });

  await upsertPermissionRows(
    supabase,
    companyId,
    Array.from(byRole, ([role_id, permission]) => ({ role_id, page_id: targetPage.id, ...permission }))
  );
  await retirePage(supabase, companyId, sourcePage.id);
}

async function copyLegacyGroupPermissions(
  supabase: SupabaseClient,
  companyId: string,
  sourceCode: string,
  childCodes: string[],
  retireSource: boolean
) {
  const pages = await getPagesByCodes(supabase, companyId, [sourceCode, ...childCodes]);
  const sourcePage = pages.get(sourceCode);
  const childPages = childCodes.map((code) => pages.get(code)).filter(Boolean) as PageRow[];
  if (!sourcePage || !childPages.length) return;

  const { data: grants, error } = await supabase
    .from("role_page_permissions")
    .select("role_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .eq("page_id", sourcePage.id);
  if (error) throw new Error(error.message);

  await upsertPermissionRows(
    supabase,
    companyId,
    (grants ?? []).flatMap((grant) => childPages.map((page) => ({
      role_id: grant.role_id,
      page_id: page.id,
      can_view: grant.can_view || grant.can_edit,
      can_add: grant.can_add,
      can_edit: grant.can_edit
    })))
  );

  if (retireSource) {
    await retirePage(supabase, companyId, sourcePage.id);
  }
}

async function seedTargetPermissionsFromSources(
  supabase: SupabaseClient,
  companyId: string,
  sourceCodes: string[],
  targetCode: string
) {
  const pages = await getPagesByCodes(supabase, companyId, [...sourceCodes, targetCode]);
  const targetPage = pages.get(targetCode);
  const sourcePages = sourceCodes.map((code) => pages.get(code)).filter(Boolean) as PageRow[];
  if (!targetPage || !sourcePages.length) return;

  const { data: grants, error } = await supabase
    .from("role_page_permissions")
    .select("role_id, page_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .in("page_id", [...sourcePages.map((page) => page.id), targetPage.id]);
  if (error) throw new Error(error.message);

  const existingTargetRoles = new Set(
    (grants ?? []).filter((grant) => grant.page_id === targetPage.id).map((grant) => grant.role_id)
  );
  const byRole = new Map<string, Omit<PermissionRow, "role_id" | "page_id">>();
  (grants ?? []).filter((grant) => grant.page_id !== targetPage.id).forEach((grant) => {
    if (existingTargetRoles.has(grant.role_id)) return;
    const current = byRole.get(grant.role_id) ?? { can_view: false, can_add: false, can_edit: false };
    byRole.set(grant.role_id, {
      can_view: current.can_view || grant.can_view || grant.can_add || grant.can_edit,
      can_add: current.can_add || grant.can_add,
      can_edit: current.can_edit || grant.can_edit
    });
  });

  await upsertPermissionRows(
    supabase,
    companyId,
    Array.from(byRole, ([role_id, permission]) => ({ role_id, page_id: targetPage.id, ...permission }))
  );
}

export async function ensureAccessPages(supabase: SupabaseClient, companyId: string) {
  if (!companyId) throw new Error("Company is required to seed access pages.");

  const now = new Date().toISOString();
  const [categoryResult, currentPagesResult] = await Promise.all([
    supabase
      .from("workforce_categories")
      .select("code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    supabase
      .from("app_pages")
      .select("id, code, name, sort_order, is_active")
      .eq("company_id", companyId)
  ]);
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  if (currentPagesResult.error) throw new Error(currentPagesResult.error.message);

  const categoryPages = ((categoryResult.data ?? []) as WorkforceCategoryRow[]).map((category, index) => ({
    code: workforceCategoryPageCode(category.code),
    name: category.name,
    sort_order: 21 + index
  })).filter((page) => page.code);
  const expectedPages = [...accessPages, ...categoryPages];
  const currentPages = currentPagesResult.data;

  const currentPageByCode = new Map((currentPages ?? []).map((page: PageRow) => [page.code, page]));

  let pageCatalogChanged = false;
  let pageTopologyChanged = false;

  for (const page of expectedPages) {
    const existing = currentPageByCode.get(page.code);
    if (existing) {
      const needsUpdate = existing.name !== page.name ||
        Number(existing.sort_order) !== page.sort_order ||
        existing.is_active === false;
      if (needsUpdate) {
        const { error } = await supabase
          .from("app_pages")
          .update({ ...page, is_active: true, updated_at: now })
          .eq("company_id", companyId)
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        pageCatalogChanged = true;
      }
      currentPageByCode.set(page.code, { ...existing, is_active: true });
    } else {
      const { data, error } = await supabase
        .from("app_pages")
        .insert({ company_id: companyId, ...page, is_active: true, created_at: now, updated_at: now })
        .select("id, code, is_active")
        .single();
      if (error) {
        if (!isDuplicatePageCodeError(error)) throw new Error(error.message);

        const { data: legacyPage, error: legacyError } = await supabase
          .from("app_pages")
          .select("id, code, is_active")
          .eq("code", page.code)
          .is("company_id", null)
          .maybeSingle();
        if (legacyError || !legacyPage) throw new Error(legacyError?.message ?? error.message);
        currentPageByCode.set(page.code, legacyPage);
      } else {
        currentPageByCode.set(page.code, data);
      }
      pageCatalogChanged = true;
      pageTopologyChanged = true;
    }
  }

  const expectedCodes = new Set(expectedPages.map((page) => page.code));
  const categoryPermissionCodes = new Set([
    "employees",
    "delivery_associates",
    "contractors",
    "vendors",
    "workers"
  ]);
  for (const page of currentPages ?? []) {
    const isCategoryPermission = categoryPermissionCodes.has(page.code) || page.code.startsWith(workforceCategoryPagePrefix);
    if (isCategoryPermission && !expectedCodes.has(page.code) && page.is_active !== false) {
      await retirePage(supabase, companyId, page.id);
      currentPageByCode.set(page.code, { ...page, is_active: false });
      pageCatalogChanged = true;
      pageTopologyChanged = true;
    }
  }

  // Normal page visits should only validate the catalog. Permission migrations
  // and role repairs are needed when the catalog changes, not on every render.
  if (!pageCatalogChanged) return;

  if (pageTopologyChanged && expectedCodes.has("delivery_associates")) {
    await mergeRetiredPagePermissions(supabase, companyId, "onboarding", "delivery_associates");
  }
  if (pageTopologyChanged) await copyLegacyGroupPermissions(supabase, companyId, "cod", [
    "cod_executive_reconciliation",
    "cod_submission",
    "cod_validation",
    "cod_reports",
    "cod_portal_checks",
    "cod_cash_in_associate"
  ], false);
  if (pageTopologyChanged) await copyLegacyGroupPermissions(supabase, companyId, "settings", [
    "master_locations",
    "master_providers",
    "master_models",
    "payment_methods",
    "master_payment_banks",
    "master_payment_heads",
    "designations",
    "biometric_devices"
  ], true);
  if (pageTopologyChanged) await copyLegacyGroupPermissions(supabase, companyId, "fleet", [
    "fleet_action_center",
    "fleet_vehicle_view",
    "fleet_date_view",
    "fleet_station_view",
    "fleet_tracking",
    "fleet_fuel_log",
    "fleet_live_gps",
    "fleet_maintenance",
    "fleet_reports"
  ], false);
  if (pageTopologyChanged) {
    const categoryCodes = categoryPages.map((page) => page.code);
    await seedTargetPermissionsFromSources(supabase, companyId, categoryCodes, "people_all");
    await seedTargetPermissionsFromSources(supabase, companyId, ["people_exceptions"], "people_review");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_reports"], "executive_id_onboarding");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_reports"], "cod_cash_in_associate");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_executive_reconciliation"], "cod_cash_in_associate");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_reports"], "performance");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cps_associates"], "capacity");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cps_associates"], "capacity_overview");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cps_associates"], "capacity_associates");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cps_associates"], "capacity_delivery");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cps_associates"], "capacity_hiring");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_reports"], "ops_reports");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_master"], "performance_master");
    await seedTargetPermissionsFromSources(supabase, companyId, ["cod_master"], "capacity_master");
    await seedTargetPermissionsFromSources(supabase, companyId, ["designations"], "workforce_categories");
    await seedTargetPermissionsFromSources(supabase, companyId, ["designations"], "workforce_whatsapp");
    await seedTargetPermissionsFromSources(supabase, companyId, ["imports"], "master_imports");
    await seedTargetPermissionsFromSources(supabase, companyId, ["attendance_reports"], "raw_punch_reports");
  }

  const activePages = Array.from(currentPageByCode.values()).filter((page) => expectedCodes.has(page.code) && page.is_active !== false);
  const ownerRole = await getFirstRoleByCode(supabase, companyId, "OWNER");
  if (ownerRole && activePages.length) {
    await upsertPermissionRows(
      supabase,
      companyId,
      activePages.map((page) => ({ role_id: ownerRole.id, page_id: page.id, ...fullAccess }))
    );
  }

  const locationRole = await getFirstRoleByCode(supabase, companyId, "LOCATION");

  if (!locationRole) {
    const { error: createLocationRoleError } = await supabase.from("user_roles").insert({
      company_id: companyId,
      code: "LOCATION",
      name: "Location",
      parent_role_id: null,
      location_access_mode: "role_based",
      is_active: true,
      is_system: false
    });
    if (createLocationRoleError && !isDuplicateRoleCodeError(createLocationRoleError)) {
      throw new Error(createLocationRoleError.message);
    }
  } else {
    const { error: retireError } = await supabase
      .from("user_roles")
      .update({ parent_role_id: null, location_access_mode: "role_based", is_active: true })
      .eq("company_id", companyId)
      .eq("id", locationRole.id);
    if (retireError) throw new Error(retireError.message);
  }
}
