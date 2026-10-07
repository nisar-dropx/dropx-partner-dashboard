import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { accessPages, ensureAccessPages } from "@/lib/access-pages";
import { loadEffectivePositionAccess } from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { loadActiveRoles, loadCompanyAccessRow, loadPeopleDesignation, loadRolePageGrants } from "@/lib/access-cache";
import { getPreviewViewer, hasPreviewProductAccess, selectedPreviewUserId } from "@/lib/portal-preview";
import { enforceAccessCutoffIfDue } from "@/lib/access-cutoff";
import { getSessionUser, legacySessionProfileColumns, loadSessionProfile, sessionProfileColumns } from "@/lib/session-user";
import { TimeoutError } from "@/lib/with-timeout";

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
  effectiveRoleIds: string[];
  effectiveRoleCodes?: string[];
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
  designationName?: string | null;
  canPreviewUsers?: boolean;
  isPreview?: boolean;
  readOnly?: boolean;
  viewerUserId?: string;
};

const noPermission: PagePermission = { canView: false, canAdd: false, canEdit: false };

const groupedParentPermissions: Record<string, string[]> = {
  fleet: ["fleet_action_center", "fleet_vehicle_view", "fleet_date_view", "fleet_station_view", "fleet_tracking", "fleet_fuel_log", "fleet_live_gps", "fleet_maintenance", "fleet_reports"],
  capacity: ["capacity_overview", "capacity_associates", "capacity_delivery", "capacity_hiring"],
  cod: ["daily_submission", "cod_executive_reconciliation", "cod_submission", "cod_validation", "cod_reports", "cod_portal_checks", "cod_cash_in_associate", "station_audits"],
  ops_pulse: [
    "performance",
    "performance_review",
    "performance_review_status",
    "capacity",
    "capacity_overview",
    "capacity_associates",
    "capacity_delivery",
    "capacity_hiring",
    "ops_reports",
    "ops_attendance_reports",
    "ops_unplanned_leaves",
    "ops_my_team",
    "ops_offboarding_checklist",
    "ops_salary_hold",
    "ops_workforce_losses",
    "ops_workforce_mileage",
    "ops_losses",
    "ops_loss_master",
    "ops_workforce_advances",
    "ops_rostering",
    "daily_submission",
    "cod",
    "cod_executive_reconciliation",
    "cod_submission",
    "cod_validation",
    "cod_reports",
    "cod_portal_checks",
    "cod_cash_in_associate",
    "station_audits",
    "station_audit_master",
    "edd_dashboard",
    "station_edd",
    "cps",
    "cps_overview",
    "cpu_overview",
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
    "advance_requests",
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
  reports: ["attendance_reports", "attendance_integrity", "raw_punch_reports", "verification_api_reports", "event_log_reports"],
  master_data: ["master_locations", "master_providers", "master_models", "payment_methods", "master_payment_banks", "master_payment_heads", "master_contacts", "workforce_categories", "workforce_whatsapp", "designations", "biometric_devices", "cod_master", "station_audit_master", "master_documents", "master_imports"],
  app_settings: ["app_settings", "ai_connector", "amazon_connector", "developer_mode"],
  payments: ["advance_requests", "expense_requests", "payment_requests", "payment_approvals", "payment_process", "workforce_payouts", "workforce_payout_disputes", "workforce_advances", "payment_reports"]
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

const ensureMissingCurrentAccessPages = unstable_cache(async (companyId: string) => {
  const requiredCodes = ["people_all", "people_review", "people_exceptions", "asset_audits", "executive_id_onboarding", "business_documents", "payments", "advance_requests", "expense_requests", "payment_requests", "payment_approvals", "payment_process", "payment_reports", "workforce_payout_disputes", "workforce_advances", "master_payment_banks", "master_payment_heads", "master_contacts", "payment_settings", "imports", "workforce_categories", "workforce_whatsapp", "master_imports", "ops_pulse", "performance", "performance_review", "performance_review_cluster_filter", "performance_review_status", "capacity", "capacity_overview", "capacity_associates", "capacity_delivery", "capacity_hiring", "ops_reports", "ops_attendance_reports", "ops_unplanned_leaves", "ops_my_team", "ops_offboarding_checklist", "ops_salary_hold", "ops_workforce_losses", "ops_workforce_mileage", "ops_losses", "ops_loss_master", "ops_provider_mapping", "ops_workforce_payouts", "ops_workforce_advances", "ops_rostering", "daily_submission", "cod", "cod_executive_reconciliation", "cod_submission", "cod_validation", "cod_reports", "cod_portal_checks", "cod_cash_in_associate", "station_audits", "station_audit_master", "edd_dashboard", "station_edd", "cod_master", "performance_master", "capacity_master", "biometric_devices", "reports", "attendance_reports", "attendance_integrity", "raw_punch_reports", "verification_api_reports", "event_log_reports", "ai_connector", "amazon_connector", "developer_mode", "cps", "cpu_overview", "cps_overview", "cps_daily", "cps_monthly", "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports", "cps_inputs", "cps_unmapped", "service_network", "service_network_master", "finance_pricing", "finance_rent", "finance_assets", "finance_revenue", "finance_pnl"];
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
}, ["current-access-pages-v9"], { revalidate: 3600 });

export const getAuthorization = cache(async (): Promise<AuthorizationContext | null> => {
  const user = await getSessionUser();
  if (!user || !supabaseAdmin) return null;
  const data = { user };
  const signedInEmail = normalizeEmail(data.user.email);

  const profileColumns = sessionProfileColumns;
  const legacyProfileColumns = legacySessionProfileColumns;

  const { data: profileById, error: profileByIdError } = await loadSessionProfile(data.user.id);

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

  if (!profile) return null;
  // Offboarding access lasts through the confirmed last working day, enforced lazily
  // (no scheduled job) — this is the moment that check runs for dashboard login.
  const isActive = profile.is_active ? await enforceAccessCutoffIfDue(profile.id) : profile.is_active;
  if (!isActive) return null;

  const viewerProfile = profile;
  const previewViewer = await getPreviewViewer();
  const requestedPreviewUserId = selectedPreviewUserId(viewerProfile.id);
  if (requestedPreviewUserId && !previewViewer) redirect("/unauthorized?reason=preview-unavailable");
  let isPreview = false;
  if (requestedPreviewUserId && requestedPreviewUserId !== viewerProfile.id && viewerProfile.company_id) {
    const target = await supabaseAdmin.from("profiles").select(profileColumns)
      .eq("id", requestedPreviewUserId).eq("company_id", viewerProfile.company_id).eq("is_active", true).maybeSingle();
    if (target.error || !target.data || !await hasPreviewProductAccess(viewerProfile.company_id, target.data.id, Boolean(target.data.is_master_owner))) redirect("/unauthorized?reason=preview-unavailable");
    profile = target.data;
    isPreview = true;
  }
  const effectiveEmail = isPreview ? normalizeEmail(profile.email) : normalizeEmail(profile.email) || signedInEmail;

  const permissions: Record<string, PagePermission> = Object.fromEntries(
    initializedPermissionCodes.map((code) => [code, { ...noPermission }])
  );
  let roleName: string | null = null;
  let hasAllLocationAccess = false;
  let locationScopeIds = Array.isArray(profile.location_scope_ids) ? profile.location_scope_ids : [];
  let companyId: string | null = typeof profile.company_id === "string" ? profile.company_id : null;
  let companyCode: string | null = null;
  let companyName: string | null = null;
  let isMasterCompany = effectiveEmail === "nisar@dropxlogistics.com";
  let isMasterOwner = Boolean(profile.is_master_owner) || effectiveEmail === "nisar@dropxlogistics.com";
  let roleCode: string | null = null;
  let effectiveRoleCodes: string[] = [];
  let effectiveRoleIds: string[] = profile.role_id ? [profile.role_id] : [];
  let primaryRoleId: string | null = profile.role_id ?? null;
  const accessSurface = currentAdminAccessSurface();

  if (!companyId) return null;

  if (companyId) {
    const company = await loadCompanyAccessRow(companyId).catch(() => null);
    if (!company?.is_active) return null;
    if (company) {
      companyId = company.id;
      companyCode = company.code;
      companyName = company.name;
      isMasterCompany = Boolean(company.is_master);
    }
    if (!isPreview) await ensureMissingCurrentAccessPages(companyId as string);
  }

  const positionAccess = await loadEffectivePositionAccess(companyId as string, profile.id);
  effectiveRoleIds = Array.from(new Set([
    ...effectiveRoleIds,
    ...positionAccess.roleIds
  ]));
  primaryRoleId = positionAccess.primaryRoleId ?? primaryRoleId;
  locationScopeIds = Array.from(new Set([
    ...locationScopeIds,
    ...positionAccess.locationScopeIds
  ]));
  hasAllLocationAccess = positionAccess.hasAllLocationAccess;

  const surfaceProductCode = accessSurface === "ops"
    ? "operations"
    : accessSurface === "people"
      ? "people"
      : accessSurface === "finance"
        ? "finance"
        : null;
  if (surfaceProductCode) {
    const membershipResult = await supabaseAdmin.from("company_product_memberships")
      .select("role_id,has_all_location_access,location_scope_ids")
      .eq("company_id", companyId)
      .eq("user_id", profile.id)
      .eq("product_code", surfaceProductCode)
      .eq("is_active", true);
    if (!membershipResult.error && !isMasterOwner) {
      const membershipRows = membershipResult.data ?? [];
      const membershipRoleIds = membershipRows.map((membership) => membership.role_id).filter((roleId): roleId is string => Boolean(roleId));
      // Ops/People/Finance must use the product membership role matrix from Settings.
      // Keep prior roles only when no active membership is configured yet.
      if (membershipRoleIds.length) {
        effectiveRoleIds = Array.from(new Set(membershipRoleIds));
        primaryRoleId = membershipRoleIds[0] ?? null;
      }
      hasAllLocationAccess = membershipRows.some((membership) => membership.has_all_location_access);
      locationScopeIds = hasAllLocationAccess
        ? []
        : Array.from(new Set(membershipRows.flatMap((membership) => membership.location_scope_ids ?? [])));
    }
  }

  if (effectiveRoleIds.length) {
    const roles = await loadActiveRoles(companyId as string, effectiveRoleIds).catch(() => null);
    if (!roles) return null;
    effectiveRoleCodes = roles.map(role => String(role.code ?? "").trim().toUpperCase());
    const primaryRole = roles.find((role) => role.id === primaryRoleId) ?? roles[0] ?? null;
    roleName = primaryRole?.name ?? null;
    roleCode = String(primaryRole?.code ?? "").trim().toUpperCase() || null;
    // Settings role "All locations" is authoritative even if membership flag is stale.
    if (roles.some((role) => role.location_access_mode === "all_locations")) {
      hasAllLocationAccess = true;
      locationScopeIds = [];
    }
    const hasLocationRole = roles.some((role) => String(role.code ?? "").trim().toUpperCase() === "LOCATION");
    if (hasLocationRole && effectiveEmail) {
      const { data: allEmailLocations } = await supabaseAdmin
        .from("stations")
        .select("id, station_email")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .not("station_email", "is", null);
      const emailLocationIds = (allEmailLocations ?? [])
        .filter((location) => normalizeEmail(location.station_email) === effectiveEmail)
        .map((location) => location.id);
      locationScopeIds = Array.from(new Set([
        ...locationScopeIds,
        ...emailLocationIds
      ]));
    }

    if (roles.some((role) => String(role.code ?? "").trim().toUpperCase() === "OWNER")) {
      hasAllLocationAccess = true;
      grantFullAccess(permissions);
    } else {
      const access = await loadRolePageGrants(companyId as string, effectiveRoleIds).catch(() => null);
      if (!access) return null;
      const codeByPageId = new Map(access.pages.map((page) => [page.id, page.code]));

      access.grants.forEach((grant) => {
        const code = codeByPageId.get(grant.page_id);
        if (!code) return;
        const current = permissions[code] ?? noPermission;
        permissions[code] = {
          canView: current.canView || grant.can_view || grant.can_edit,
          canAdd: current.canAdd || grant.can_add,
          canEdit: current.canEdit || grant.can_edit
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

  const designation = companyId ? await loadPeopleDesignation(companyId, profile.id) : undefined;
  return {
    designationName: designation?.name ?? null,
    canPreviewUsers: Boolean(previewViewer),
    isPreview,
    readOnly: isPreview,
    viewerUserId: viewerProfile.id,
    companyCode,
    companyId,
    companyName,
    email: isPreview ? profile.email ?? null : data.user.email ?? null,
    effectiveRoleIds,
    effectiveRoleCodes,
    fullName: profile.full_name,
    hasAllLocationAccess,
    isMasterCompany,
    isMasterOwner,
    locationScopeIds,
    permissions,
    roleCode,
    roleId: primaryRoleId,
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
  if (pageCode === "request_tracker") return (action === "access" || action === "view") && isCompanyOwner(authorization);
  if (authorization.readOnly && (action === "add" || action === "edit")) return false;
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

/**
 * For Server Actions only: a page load has no in-progress user input to lose,
 * so requirePagePermission's redirect-on-any-failure is fine there. A Server
 * Action triggered mid-form does have input worth preserving - on a Supabase
 * timeout specifically, throw a plain Error instead of redirecting, so the
 * action's own try/catch can surface a retryable message rather than
 * navigating the browser away and discarding what the user was entering. A
 * genuine "not signed in" or "not permitted" result still redirects exactly
 * as before.
 */
export async function requirePagePermissionOrThrow(pageCode: string, action: PermissionAction) {
  let authorization: AuthorizationContext | null;
  try {
    authorization = await getAuthorization();
  } catch (error) {
    if (error instanceof TimeoutError) throw new Error("Couldn't verify your session right now. Please try again.");
    throw error;
  }
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, pageCode, action)) {
    redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}&action=${action}`);
  }
  return authorization;
}
