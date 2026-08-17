import { redirect } from "next/navigation";
import { cache } from "react";
import { accessPages, ensureAccessPages } from "@/lib/access-pages";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export type PermissionAction = "access" | "view" | "add" | "edit";

export type PagePermission = {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
};

export type AuthorizationContext = {
  companyCode: string | null;
  companyId: string | null;
  companyName: string | null;
  email: string | null;
  fullName: string | null;
  hasAllLocationAccess: boolean;
  isMasterCompany: boolean;
  isMasterOwner: boolean;
  locationScopeIds: string[];
  permissions: Record<string, PagePermission>;
  roleCode: string | null;
  roleId: string | null;
  roleName: string | null;
  userId: string;
};

const noPermission: PagePermission = { canView: false, canAdd: false, canEdit: false };

const groupedParentPermissions: Record<string, string[]> = {
  leads: ["leads_dashboard", "leads_all", "leads_followups", "leads_interviews", "leads_reports", "leads_ads", "leads_sop"],
  fleet: ["fleet_action_center", "fleet_vehicle_view", "fleet_date_view", "fleet_station_view", "fleet_tracking", "fleet_fuel_log", "fleet_live_gps", "fleet_maintenance", "fleet_reports"],
  capacity: ["capacity_overview", "capacity_associates", "capacity_delivery", "capacity_hiring"],
  cod: ["daily_submission", "cod_executive_reconciliation", "cod_submission", "cod_validation", "cod_reports", "cod_portal_checks", "cod_cash_in_associate"],
  ops_pulse: [
    "performance",
    "capacity",
    "capacity_overview",
    "capacity_associates",
    "capacity_delivery",
    "capacity_hiring",
    "ops_reports",
    "daily_submission",
    "cod",
    "cod_executive_reconciliation",
    "cod_submission",
    "cod_validation",
    "cod_reports",
    "cod_portal_checks",
    "cod_cash_in_associate",
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
    "expense_requests",
    "payment_requests",
    "payment_approvals",
    "fleet",
    "fleet_action_center",
    "fleet_vehicle_view",
    "fleet_date_view",
    "fleet_station_view",
    "fleet_tracking",
    "fleet_fuel_log",
    "fleet_live_gps",
    "fleet_maintenance",
    "fleet_reports",
    "master_locations",
    "master_providers",
    "master_models",
    "cod_master",
    "performance_master",
    "capacity_master",
    "imports",
    "users"
  ],
  cps: ["cps_overview", "cps_daily", "cps_monthly", "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports", "cps_inputs", "cps_unmapped"],
  reports: ["attendance_reports", "raw_punch_reports", "verification_api_reports", "event_log_reports"],
  master_data: ["master_locations", "master_providers", "master_models", "payment_methods", "master_payment_banks", "master_payment_heads", "master_contacts", "workforce_categories", "workforce_whatsapp", "designations", "biometric_devices", "cod_master", "master_documents", "master_imports"],
  app_settings: ["app_settings", "ai_connector", "amazon_connector", "developer_mode"],
  payments: ["expense_requests", "payment_requests", "payment_approvals", "payment_process", "payment_reports"]
};

const peopleProfilePageCodes = [
  "delivery_associates",
  "employees",
  "contractors",
  "vendors",
  "workers"
];

const initializedPermissionCodes = Array.from(new Set([
  ...accessPages.map((page) => page.code),
  ...peopleProfilePageCodes
]));

function grantFullAccess(permissions: Record<string, PagePermission>) {
  initializedPermissionCodes.forEach((code) => {
    permissions[code] = { canView: true, canAdd: true, canEdit: true };
  });
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function inheritGroupedParentPermissions(permissions: Record<string, PagePermission>) {
  for (const [parentCode, childCodes] of Object.entries(groupedParentPermissions)) {
    const inherited = childCodes.reduce<PagePermission>((acc, code) => {
      const permission = permissions[code] ?? noPermission;
      return {
        canView: acc.canView || permission.canView || permission.canAdd || permission.canEdit,
        canAdd: acc.canAdd || permission.canAdd,
        canEdit: acc.canEdit || permission.canEdit
      };
    }, { ...noPermission });

    permissions[parentCode] = {
      canView: inherited.canView || inherited.canAdd || inherited.canEdit,
      canAdd: inherited.canAdd,
      canEdit: inherited.canEdit
    };
  }
}

async function ensureMissingCurrentAccessPages(companyId: string) {
  const requiredCodes = ["people_all", "people_review", "people_exceptions", "executive_id_onboarding", "business_documents", "payments", "expense_requests", "payment_requests", "payment_approvals", "payment_process", "payment_reports", "master_payment_banks", "master_payment_heads", "master_contacts", "payment_settings", "imports", "workforce_categories", "workforce_whatsapp", "master_imports", "ops_pulse", "performance", "capacity", "capacity_overview", "capacity_associates", "capacity_delivery", "capacity_hiring", "ops_reports", "daily_submission", "cod", "cod_executive_reconciliation", "cod_submission", "cod_validation", "cod_reports", "cod_portal_checks", "cod_cash_in_associate", "cod_master", "performance_master", "capacity_master", "biometric_devices", "reports", "attendance_reports", "raw_punch_reports", "verification_api_reports", "event_log_reports", "ai_connector", "amazon_connector", "developer_mode", "cps", "cps_overview", "cps_daily", "cps_monthly", "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports", "cps_inputs", "cps_unmapped", "service_network", "service_network_master"];
  const { data, error } = await supabaseAdmin!
    .from("app_pages")
    .select("code")
    .eq("company_id", companyId)
    .in("code", requiredCodes);
  if (error && !isMissingColumnError(error)) return;
  const existingCodes = new Set((data ?? []).map((page) => page.code));
  if (requiredCodes.some((code) => !existingCodes.has(code))) {
    await ensureAccessPages(supabaseAdmin!, companyId);
  }
}

export const getAuthorization = cache(async (): Promise<AuthorizationContext | null> => {
  const supabase = createServerSupabaseClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (!data.user || !supabaseAdmin) return null;
  const signedInEmail = normalizeEmail(data.user.email);

  const profileColumns = "id, email, full_name, role_id, location_scope_ids, is_active, company_id, is_master_owner";
  const legacyProfileColumns = "id, email, full_name, role_id, location_scope_ids, is_active";

  let { data: profileById, error: profileByIdError } = await supabaseAdmin
    .from("profiles")
    .select(profileColumns)
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileByIdError && isMissingColumnError(profileByIdError)) {
    const legacyResult = await supabaseAdmin
      .from("profiles")
      .select(legacyProfileColumns)
      .eq("id", data.user.id)
      .maybeSingle();
    profileById = legacyResult.data as typeof profileById;
    profileByIdError = legacyResult.error;
  }

  if (profileByIdError) return null;

  let profile = profileById;
  if (!profile) {
    let { data: profileRows, error: profileRowsError } = await supabaseAdmin
      .from("profiles")
      .select(profileColumns)
      .not("email", "is", null);
    if (profileRowsError && isMissingColumnError(profileRowsError)) {
      const legacyRowsResult = await supabaseAdmin
        .from("profiles")
        .select(legacyProfileColumns)
        .not("email", "is", null);
      profileRows = legacyRowsResult.data as typeof profileRows;
      profileRowsError = legacyRowsResult.error;
    }
    if (profileRowsError) return null;
    const emailMatches = (profileRows ?? []).filter((item) => normalizeEmail(item.email) === signedInEmail);
    const activeEmailMatches = emailMatches.filter((item) => item.is_active);
    const masterOwnerMatch = activeEmailMatches.find((item) => item.is_master_owner);
    profile = activeEmailMatches.length === 1 ? activeEmailMatches[0] : (masterOwnerMatch && signedInEmail === "nisar@dropxlogistics.com" ? masterOwnerMatch : null);
  }

  if (!profile?.is_active) return null;

  const permissions: Record<string, PagePermission> = Object.fromEntries(
    initializedPermissionCodes.map((code) => [code, { ...noPermission }])
  );
  let roleName: string | null = null;
  let hasAllLocationAccess = false;
  let locationScopeIds = Array.isArray(profile.location_scope_ids) ? profile.location_scope_ids : [];
  let companyId: string | null = typeof profile.company_id === "string" ? profile.company_id : null;
  let companyCode: string | null = null;
  let companyName: string | null = null;
  let isMasterCompany = signedInEmail === "nisar@dropxlogistics.com";
  let isMasterOwner = Boolean(profile.is_master_owner) || signedInEmail === "nisar@dropxlogistics.com";
  let roleCode: string | null = null;

  if (!companyId) return null;

  if (companyId) {
    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("id, code, name, is_master, is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (!company?.is_active) return null;
    if (company) {
      companyId = company.id;
      companyCode = company.code;
      companyName = company.name;
      isMasterCompany = Boolean(company.is_master);
    }
    await ensureMissingCurrentAccessPages(companyId as string);
  }

  if (profile.role_id) {
    const { data: role } = await supabaseAdmin
      .from("user_roles")
      .select("name, code, location_access_mode, is_system, is_active")
      .eq("id", profile.role_id)
      .maybeSingle();

    roleName = role?.name ?? null;
    hasAllLocationAccess = role?.location_access_mode === "all_locations";

    roleCode = String(role?.code ?? "").trim().toUpperCase() || null;

    if (role?.is_active && roleCode === "LOCATION" && data.user.email) {
      const { data: allEmailLocations } = await supabaseAdmin
        .from("stations")
        .select("id, station_email")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .not("station_email", "is", null);
      const emailLocationIds = (allEmailLocations ?? [])
        .filter((location) => normalizeEmail(location.station_email) === signedInEmail)
        .map((location) => location.id);
      locationScopeIds = Array.from(new Set([
        ...locationScopeIds,
        ...emailLocationIds
      ]));
    }

    if (role?.is_active && roleCode === "OWNER") {
      hasAllLocationAccess = true;
      grantFullAccess(permissions);
  } else if (role?.is_active) {
    let pagesResult = await supabaseAdmin
      .from("app_pages")
      .select("id, code")
      .eq("company_id", companyId)
      .eq("is_active", true);

    if (pagesResult.error && isMissingColumnError(pagesResult.error)) {
      pagesResult = await supabaseAdmin.from("app_pages").select("id, code").eq("is_active", true);
    }
    if (!pagesResult.error && !(pagesResult.data ?? []).length) {
      pagesResult = await supabaseAdmin
        .from("app_pages")
        .select("id, code")
        .in("code", accessPages.map((page) => page.code))
        .is("company_id", null)
        .eq("is_active", true);
    }

    let grantsResult = await supabaseAdmin
      .from("role_page_permissions")
      .select("page_id, can_view, can_add, can_edit")
      .eq("company_id", companyId)
      .eq("role_id", profile.role_id);

    if (grantsResult.error && isMissingColumnError(grantsResult.error)) {
      grantsResult = await supabaseAdmin
        .from("role_page_permissions")
        .select("page_id, can_view, can_add, can_edit")
        .eq("role_id", profile.role_id);
    }

    if (pagesResult.error || grantsResult.error) {
      return null;
    }

    const codeByPageId = new Map((pagesResult.data ?? []).map((page) => [page.id, page.code]));

    (grantsResult.data ?? []).forEach((grant) => {
      const code = codeByPageId.get(grant.page_id);
      if (!code) return;
      permissions[code] = {
          canView: grant.can_view || grant.can_edit,
          canAdd: grant.can_add,
          canEdit: grant.can_edit
        };
      });
    }
  }

  inheritGroupedParentPermissions(permissions);

  if (isMasterOwner) {
    hasAllLocationAccess = true;
    grantFullAccess(permissions);
    permissions.company_master = { canView: true, canAdd: true, canEdit: true };
  } else if (!isMasterCompany) {
    permissions.company_master = { ...noPermission };
  }

  return {
    companyCode,
    companyId,
    companyName,
    email: data.user.email ?? null,
    fullName: profile.full_name,
    hasAllLocationAccess,
    isMasterCompany,
    isMasterOwner,
    locationScopeIds,
    permissions,
    roleCode,
    roleId: profile.role_id,
    roleName,
    userId: profile.id
  };
});

export function isCompanyOwner(authorization: AuthorizationContext) {
  return authorization.isMasterOwner || authorization.roleCode === "OWNER";
}

export function hasPermission(
  authorization: AuthorizationContext,
  pageCode: string,
  action: PermissionAction
) {
  if (isCompanyOwner(authorization)) return true;
  const permission = authorization.permissions[pageCode] ?? noPermission;
  if (action === "access") return permission.canView || permission.canAdd || permission.canEdit;
  if (action === "add") return permission.canAdd;
  if (action === "edit") return permission.canEdit;
  return permission.canView;
}

export async function requirePagePermission(pageCode: string, action: PermissionAction) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, pageCode, action)) {
    redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}&action=${action}`);
  }
  return authorization;
}
