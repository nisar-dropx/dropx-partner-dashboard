import { NextRequest, NextResponse } from "next/server";
import { ensureAccessPages } from "@/lib/access-pages";
import { createOpsAuthTransfer } from "@/lib/ops-auth-transfer";
import { isPeopleHostName, safePeopleNextPath } from "@/lib/people/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function emailsFromField(value: string | null | undefined): string[] {
  const text = normalizeEmail(value);
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
}

function emailDomain(value: string) {
  return value.split("@").pop()?.trim().toLowerCase() ?? "";
}

function safeNextPath(value: string | null) {
  const text = String(value ?? "").trim();
  if (!text || !text.startsWith("/") || text.startsWith("//")) return "";

  try {
    const parsed = new URL(text, "https://dashboard.dropxlogistics.com");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function isMissingTableError(error: { code?: string; message?: string } | null | undefined) {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.code === "42P01" || message.includes("does not exist") || message.includes("schema cache");
}

function isDuplicateRoleCodeError(error: { message?: string } | null | undefined) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("user_roles_code_key") ||
    (message.includes("duplicate key") && message.includes("user_roles") && message.includes("code"));
}

async function getMasterCompanyId() {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("code", "DROPX_LOGISTICS")
    .eq("is_active", true)
    .maybeSingle();
  return data?.id ?? null;
}

async function isCompanyLoginAllowed(companyId: string | null | undefined) {
  if (!supabaseAdmin || !companyId) return false;
  const { data } = await supabaseAdmin
    .from("companies")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();
  return Boolean(data?.is_active);
}

async function isEmailDomainAllowedForCompany(companyId: string | null | undefined, email: string) {
  if (!supabaseAdmin || !companyId) return true;
  const { data, error } = await supabaseAdmin
    .from("company_allowed_domains")
    .select("domain")
    .eq("company_id", companyId)
    .eq("is_active", true);

  if (error) {
    if (isMissingTableError(error)) return true;
    console.error("Company domain allowlist lookup failed", { companyId, message: error.message });
    return true;
  }

  const allowedDomains = (data ?? [])
    .map((row) => String(row.domain ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (!allowedDomains.length) return true;
  return allowedDomains.includes(emailDomain(email));
}

async function ensureCompanyOwnerRoleId(companyId: string) {
  if (!supabaseAdmin) return null;

  const { data: role, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("company_id", companyId)
    .eq("code", "OWNER")
    .maybeSingle();
  if (error) {
    console.error("Company admin owner role lookup failed", { companyId, message: error.message });
    return null;
  }
  if (role?.id) return role.id as string;

  const { data: legacyRole, error: legacyRoleError } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("code", "OWNER")
    .maybeSingle();
  if (legacyRoleError) {
    console.error("Company admin legacy owner role lookup failed", { companyId, message: legacyRoleError.message });
    return null;
  }
  if (legacyRole?.id) return legacyRole.id as string;

  const { data: createdRole, error: createError } = await supabaseAdmin
    .from("user_roles")
    .insert({
      company_id: companyId,
      code: "OWNER",
      name: "Owner",
      location_access_mode: "all_locations",
      is_active: true,
      is_system: true
    })
    .select("id")
    .single();
  if (createError) {
    if (isDuplicateRoleCodeError(createError)) {
      const { data: duplicateRole } = await supabaseAdmin
        .from("user_roles")
        .select("id")
        .eq("code", "OWNER")
        .maybeSingle();
      if (duplicateRole?.id) return duplicateRole.id as string;
    }
    console.error("Company admin owner role create failed", { companyId, message: createError.message });
    return null;
  }
  return createdRole.id as string;
}

async function createCompanyAdminProfileForLogin(authUserId: string, email: string, fallbackName: string) {
  if (!supabaseAdmin) return null;

  const { data: companies, error: companyError } = await supabaseAdmin
    .from("companies")
    .select("id, admin_name, admin_email, admin_mobile")
    .ilike("admin_email", email)
    .eq("is_active", true)
    .limit(2);
  if (companyError) {
    console.error("Company admin login company lookup failed", { email, message: companyError.message });
    return null;
  }

  if ((companies ?? []).length !== 1) return null;

  const company = companies![0];
  const ownerRoleId = await ensureCompanyOwnerRoleId(company.id);
  if (!ownerRoleId) return null;

  const fullName = String(company.admin_name || fallbackName || email.split("@")[0]).trim();
  const { data: createdProfile, error: createError } = await supabaseAdmin
    .from("profiles")
    .upsert({
      id: authUserId,
      email,
      full_name: fullName,
      mobile: company.admin_mobile ?? null,
      role_id: ownerRoleId,
      reports_to_user_id: null,
      location_scope_ids: [],
      company_id: company.id,
      invite_method: "Company Admin",
      is_master_owner: false,
      is_active: true
    }, { onConflict: "id" })
    .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
    .single();

  if (createError) {
    console.error("Company admin login profile create failed", { email, companyId: company.id, message: createError.message });
    return null;
  }

  return createdProfile;
}

async function ensureAccessPagesForLogin(companyId: string | null | undefined) {
  if (!supabaseAdmin || !companyId) return;
  try {
    await ensureAccessPages(supabaseAdmin, companyId);
  } catch (error) {
    console.error("Auth callback access page setup failed", {
      companyId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const errorDescription = request.nextUrl.searchParams.get("error_description");
  const loginUrl = new URL("/login", request.url);
  const callbackResponse = NextResponse.redirect(new URL("/dashboard", request.url));
  const returnToOps = request.cookies.get("dropx_ops_auth_return")?.value === "1";
  const supabase = createServerSupabaseClient(callbackResponse);

  try {
    if (!code) {
      loginUrl.searchParams.set("error", errorDescription ?? "Google login was cancelled.");
      return NextResponse.redirect(loginUrl);
    }

    if (!supabase || !supabaseAdmin) {
      loginUrl.searchParams.set("error", "Authentication is not configured.");
      return NextResponse.redirect(loginUrl);
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user?.email) {
      loginUrl.searchParams.set("error", error?.message ?? "Google login could not be completed.");
      return NextResponse.redirect(loginUrl);
    }

    const email = normalizeEmail(data.user.email);
    const host = request.nextUrl.host.split(":")[0].toLowerCase();
    const isPlatformAdminHost = host === "admin-panel.dropxlogistics.com";
    const isPeopleHost = isPeopleHostName(host);

    const { data: profileById } = await supabaseAdmin
    .from("profiles")
    .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
    .eq("id", data.user.id)
    .maybeSingle();
  let profile = profileById;
  if (!profile) {
    const { data: emailProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
      .ilike("email", email);
    const activeEmailProfiles = (emailProfiles ?? []).filter((item) => item.is_active);
    const masterOwnerProfile = activeEmailProfiles.find((item) => item.is_master_owner);
    profile = activeEmailProfiles.length === 1
      ? activeEmailProfiles[0]
      : (isPlatformAdminHost ? masterOwnerProfile ?? null : null);
  }

  if (!profile && !isPlatformAdminHost) {
    const fallbackName = String(
      data.user.user_metadata?.full_name ||
      data.user.user_metadata?.name ||
      ""
    ).trim();
    profile = await createCompanyAdminProfileForLogin(data.user.id, email, fallbackName);
  }

  const [{ data: allEmailLocations }, { data: locationRoles }] = await Promise.all([
    supabaseAdmin
      .from("stations")
      .select("id, station_email, is_active, company_id")
      .not("station_email", "is", null),
    supabaseAdmin
      .from("user_roles")
      .select("id, is_active, company_id")
      .eq("code", "LOCATION")
  ]);

  const allMatchedEmailLocations = (allEmailLocations ?? []).filter(
    (location) => emailsFromField(location.station_email).includes(email)
  );
  const activeEmailLocations = allMatchedEmailLocations.filter((location) => location.is_active !== false);
  const candidateEmailLocations = (activeEmailLocations.length ? activeEmailLocations : allMatchedEmailLocations)
    .filter((location) => !profile?.company_id || location.company_id === profile.company_id);
  const matchedCompanyIds = Array.from(new Set(candidateEmailLocations.map((location) => location.company_id).filter(Boolean)));
  const emailLocationIds = candidateEmailLocations
    .map((location) => location.id);
  const locationCompanyId = profile?.company_id ?? (matchedCompanyIds.length === 1 ? matchedCompanyIds[0] : await getMasterCompanyId());
  const locationRole = (locationRoles ?? []).find((role) => role.company_id === locationCompanyId) ??
    (locationRoles ?? []).find((role) => !role.company_id) ??
    null;

  if (locationRole && !locationRole.is_active) {
    await supabaseAdmin
      .from("user_roles")
      .update({ is_active: true, parent_role_id: null, location_access_mode: "role_based" })
      .eq("id", locationRole.id);
  }

  if (!profile && emailLocationIds.length && locationRole && matchedCompanyIds.length <= 1) {
    const fullName = String(
      data.user.user_metadata?.full_name ||
      data.user.user_metadata?.name ||
      email.split("@")[0]
    ).trim();
    const { data: createdProfile, error: createProfileError } = await supabaseAdmin
      .from("profiles")
      .insert({
        id: data.user.id,
        email,
        full_name: fullName,
        role_id: locationRole.id,
        location_scope_ids: emailLocationIds,
        company_id: locationCompanyId,
        invite_method: "Google",
        is_active: true
      })
      .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
      .single();
    profile = createdProfile;
    if (createProfileError) {
      console.error("Location email profile create failed", {
        email,
        locationCount: emailLocationIds.length,
        message: createProfileError.message
      });
    }
  } else if (profile && emailLocationIds.length && locationRole && (!profile.is_active || !profile.role_id || profile.role_id === locationRole.id)) {
    const combinedLocationScope = Array.from(new Set([
      ...(profile.location_scope_ids ?? []),
      ...emailLocationIds
    ]));
    const { data: updatedProfile, error: updateProfileError } = await supabaseAdmin
      .from("profiles")
      .update({
        role_id: locationRole.id,
        location_scope_ids: combinedLocationScope,
        company_id: profile.company_id ?? locationCompanyId,
        is_active: true
      })
      .eq("id", profile.id)
      .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
      .single();
    profile = updatedProfile ?? profile;
    if (updateProfileError) {
      console.error("Location email profile update failed", {
        email,
        locationCount: emailLocationIds.length,
        message: updateProfileError.message
      });
    }
  }

  if (!profile?.is_active) {
    console.error("Login rejected because no active profile was resolved", {
      email,
      matchedLocationCount: allMatchedEmailLocations.length,
      usableLocationCount: emailLocationIds.length,
      profileFound: Boolean(profile),
      profileActive: Boolean(profile?.is_active),
      locationRoleFound: Boolean(locationRole)
    });
    await supabase.auth.signOut();
    loginUrl.searchParams.set("error", "Your account is not active in the DropX dashboard. Contact an administrator.");
    return NextResponse.redirect(loginUrl);
  }

  if (profile && !profile.company_id) {
    const masterCompanyId = await getMasterCompanyId();
    if (masterCompanyId) {
      const { data: updatedProfile } = await supabaseAdmin
        .from("profiles")
        .update({ company_id: masterCompanyId })
        .eq("id", profile.id)
        .select("id, email, role_id, location_scope_ids, is_active, company_id, is_master_owner")
        .single();
      profile = updatedProfile ?? profile;
    }
  }

  if (!await isCompanyLoginAllowed(profile.company_id)) {
    console.error("Login rejected because company is missing or inactive", {
      email,
      profileId: profile.id,
      companyId: profile.company_id ?? null
    });
    await supabase.auth.signOut();
    loginUrl.searchParams.set("error", "Your company is not active in the DropX dashboard. Contact an administrator.");
    return NextResponse.redirect(loginUrl);
  }

  await ensureAccessPagesForLogin(profile.company_id);

  if (!isPlatformAdminHost && !await isEmailDomainAllowedForCompany(profile.company_id, email)) {
    console.error("Login rejected because email domain is not allowed for company", {
      email,
      profileId: profile.id,
      companyId: profile.company_id ?? null
    });
    await supabase.auth.signOut();
    loginUrl.searchParams.set("error", "Your email domain is not allowed for this company. Contact an administrator.");
    return NextResponse.redirect(loginUrl);
  }

    const requestedNextPath = request.nextUrl.searchParams.get("next");
    const nextPath = isPeopleHost ? safePeopleNextPath(requestedNextPath) : safeNextPath(requestedNextPath);
    const destinationPath = isPlatformAdminHost
      ? (nextPath.startsWith("/platform-admin") ? nextPath : "/platform-admin")
      : (returnToOps ? "/ops-pulse" : (isPeopleHost ? nextPath : (nextPath || "/dashboard")));
    if (returnToOps && data.session) {
      const opsUrl = new URL("/auth/ops-transfer", process.env.OPS_APP_URL?.trim() || "https://ops.dropxlogistics.com");
      opsUrl.searchParams.set(
        "token",
        createOpsAuthTransfer(data.session.access_token, data.session.refresh_token)
      );
      callbackResponse.headers.set("location", opsUrl.toString());
    } else {
      callbackResponse.headers.set("location", new URL(destinationPath, request.url).toString());
    }
    if (returnToOps) {
      callbackResponse.cookies.set("dropx_ops_auth_return", "", {
        domain: ".dropxlogistics.com",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
        maxAge: 0
      });
    }
    return callbackResponse;
  } catch (error) {
    console.error("Auth callback failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    if (supabase) await supabase.auth.signOut();
    loginUrl.searchParams.set("error", "Google login could not be completed. Please try again.");
    return NextResponse.redirect(loginUrl);
  }
}
