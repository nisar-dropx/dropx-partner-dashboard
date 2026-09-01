"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { platformModules } from "@/lib/platform-modules";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function normalizeCompanyCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeEmail(value: FormDataEntryValue | null) {
  return clean(value)?.toLowerCase() ?? null;
}

function normalizeMobile(value: FormDataEntryValue | null) {
  return clean(value)?.replace(/[^\d+]/g, "") ?? null;
}

function makeWebhookKey(companyCode: string) {
  return `${companyCode.toLowerCase()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("") + "Aa1!";
}

function isExistingUserError(message: string) {
  const text = message.toLowerCase();
  return text.includes("already") || text.includes("registered") || text.includes("exists");
}

function isDuplicateRoleCodeError(message: string) {
  const text = message.toLowerCase();
  return text.includes("user_roles_code_key") ||
    (text.includes("duplicate key") && text.includes("user_roles") && text.includes("code"));
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function platformRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_platform_admin_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 20,
    path: "/platform-admin",
    sameSite: "lax"
  });
  redirect("/platform-admin");
}

function selectedModules(formData: FormData) {
  const allowed = new Set(platformModules.map((module) => module.code));
  return new Set(
    formData
      .getAll("module_codes")
      .map((value) => String(value))
      .filter((value) => allowed.has(value as never))
  );
}

async function requirePlatformAdmin(action: "add" | "edit") {
  const authorization = await requirePagePermission("company_master", action);
  if (!authorization.isMasterOwner && !authorization.isMasterCompany) {
    platformRedirect({ error: "Only master company users can manage platform companies." });
  }
  return authorization;
}

async function saveModuleAccess(companyId: string, formData: FormData) {
  const enabledModules = selectedModules(formData);
  const rows = platformModules.map((module) => ({
    company_id: companyId,
    module_code: module.code,
    is_enabled: enabledModules.has(module.code),
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabaseAdmin!
    .from("company_module_access")
    .upsert(rows, { onConflict: "company_id,module_code" });
  if (error) throw new Error(error.message);
}

async function deleteCompanyScopedSettings(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const deletions = [
    supabaseAdmin.from("whatsapp_notification_configs").delete().eq("company_id", companyId),
    supabaseAdmin.from("whatsapp_template_cache").delete().eq("company_id", companyId),
    supabaseAdmin.from("whatsapp_profiles").delete().eq("company_id", companyId),
    supabaseAdmin.from("meta_channel_profiles").delete().eq("company_id", companyId),
    supabaseAdmin.from("leads").delete().eq("company_id", companyId),
    supabaseAdmin.from("lead_ads").delete().eq("company_id", companyId),
    supabaseAdmin.from("lead_job_roles").delete().eq("company_id", companyId),
    supabaseAdmin.from("whatsapp_settings").delete().eq("company_id", companyId),
    supabaseAdmin.from("meta_messaging_settings").delete().eq("company_id", companyId),
    supabaseAdmin.from("meta_leads_settings").delete().eq("company_id", companyId),
    supabaseAdmin.from("wheelseye_settings").delete().eq("company_id", companyId),
    supabaseAdmin.from("secrets").delete().eq("company_id", companyId)
  ];

  for (const deletion of deletions) {
    const { error } = await deletion;
    if (error) throw new Error(error.message);
  }
}

async function findAuthUserIdByEmail(email: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(error.message);

    const match = data.users.find((user) => String(user.email ?? "").trim().toLowerCase() === email);
    if (match?.id) return match.id;
    if (data.users.length < 100) break;
  }

  return null;
}

async function findProfilesByEmail(email: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, company_id, is_master_owner")
    .eq("email", email)
    .limit(10);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function assertEmailCanBelongToCompany(email: string, companyId: string, label: string) {
  const profiles = await findProfilesByEmail(email);
  const conflictingProfile = profiles.find((profile) => profile.company_id && profile.company_id !== companyId);
  if (conflictingProfile) {
    throw new Error(`${label} is already linked to another company. Use a different email or delete that user from the other company first.`);
  }
  return profiles;
}

async function assertControlPanelEmailAvailable(email: string, masterCompanyId: string, currentUserId?: string) {
  const profiles = await findProfilesByEmail(email);
  const conflictingProfile = profiles.find((profile) => {
    if (currentUserId && profile.id === currentUserId) return false;
    return profile.company_id !== masterCompanyId || !profile.is_master_owner;
  });
  if (conflictingProfile) {
    throw new Error("This email is already linked to a tenant company. Use a different control panel email.");
  }
  return profiles;
}

async function ensureOwnerRoleId(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const { data: role, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("company_id", companyId)
    .eq("code", "OWNER")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (role?.id) return role.id as string;

  const { data: legacyRole, error: legacyRoleError } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("code", "OWNER")
    .maybeSingle();
  if (legacyRoleError) throw new Error(legacyRoleError.message);
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
    if (!isDuplicateRoleCodeError(createError.message)) throw new Error(createError.message);
    const { data: duplicateRole, error: duplicateRoleError } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("code", "OWNER")
      .maybeSingle();
    if (duplicateRoleError || !duplicateRole?.id) throw new Error(duplicateRoleError?.message ?? createError.message);
    return duplicateRole.id as string;
  }
  return createdRole.id as string;
}

async function ensureCompanyAdminProfile(companyId: string, fullName: string, email: string, mobile: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const ownerRoleId = await ensureOwnerRoleId(companyId);
  const existingProfiles = await assertEmailCanBelongToCompany(email, companyId, "Admin email");
  const existingCompanyProfile = existingProfiles.find((profile) => profile.company_id === companyId);
  const existingAuthUserId = await findAuthUserIdByEmail(email);
  let userId = existingCompanyProfile?.id ?? existingAuthUserId ?? null;

  if (!userId) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      phone: mobile ?? undefined,
      password: randomPassword(),
      email_confirm: true,
      user_metadata: { full_name: fullName, login_source: "company_admin" }
    });
    if (error) {
      if (!isExistingUserError(error.message)) throw new Error(error.message);
      userId = await findAuthUserIdByEmail(email);
    } else {
      userId = data.user?.id ?? null;
    }
  }

  if (!userId) throw new Error("Company admin auth user could not be created.");

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert({
      id: userId,
      full_name: fullName,
      email,
      mobile,
      role_id: ownerRoleId,
      reports_to_user_id: null,
      location_scope_ids: [],
      company_id: companyId,
      is_master_owner: false,
      invite_method: "Company Admin",
      is_active: true
    }, { onConflict: "id" });

  if (error) throw new Error(error.message);
}

async function getMasterCompanyId() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("is_master", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Master company is not configured.");
  return data.id as string;
}

async function ensureControlPanelProfile(fullName: string, email: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const masterCompanyId = await getMasterCompanyId();
  const ownerRoleId = await ensureOwnerRoleId(masterCompanyId);
  const existingProfiles = await assertControlPanelEmailAvailable(email, masterCompanyId);
  const existingMasterProfile = existingProfiles.find((profile) => profile.company_id === masterCompanyId);
  const existingAuthUserId = await findAuthUserIdByEmail(email);
  if (existingAuthUserId && !existingMasterProfile) {
    throw new Error("This email already exists in authentication outside the control panel. Use a different control panel email.");
  }
  let userId = existingMasterProfile?.id ?? null;

  if (!userId) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: randomPassword(),
      email_confirm: true,
      user_metadata: { full_name: fullName, login_source: "platform_admin" }
    });
    if (error) {
      if (!isExistingUserError(error.message)) throw new Error(error.message);
      throw new Error("This email already exists in authentication outside the control panel. Use a different control panel email.");
    } else {
      userId = data.user?.id ?? null;
    }
  }

  if (!userId) throw new Error("Control panel auth user could not be created.");

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert({
      id: userId,
      full_name: fullName,
      email,
      role_id: ownerRoleId,
      reports_to_user_id: null,
      location_scope_ids: [],
      company_id: masterCompanyId,
      is_master_owner: true,
      invite_method: "Platform Admin",
      is_active: true
    }, { onConflict: "id" });

  if (error) throw new Error(error.message);
}

export async function createControlPanelUser(formData: FormData) {
  await requirePlatformAdmin("add");

  try {
    const fullName = required(formData.get("full_name"), "Name");
    const email = normalizeEmail(formData.get("email"));
    if (!email) throw new Error("Email is required.");

    await ensureControlPanelProfile(fullName, email);
    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Control panel user added." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to add control panel user." });
  }
}

export async function updateControlPanelUser(formData: FormData) {
  await requirePlatformAdmin("edit");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "User");
    const fullName = required(formData.get("full_name"), "Name");
    const email = normalizeEmail(formData.get("email"));
    if (!email) throw new Error("Email is required.");
    const isActive = clean(formData.get("status")) !== "inactive";
    const masterCompanyId = await getMasterCompanyId();
    const ownerRoleId = await ensureOwnerRoleId(masterCompanyId);
    await assertControlPanelEmailAvailable(email, masterCompanyId, id);

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(id, {
      email,
      user_metadata: { full_name: fullName, login_source: "platform_admin" }
    });
    if (authError) throw new Error(authError.message);

    const { error } = await supabaseAdmin
      .from("profiles")
      .upsert({
        id,
        full_name: fullName,
        email,
        role_id: ownerRoleId,
        reports_to_user_id: null,
        location_scope_ids: [],
        company_id: masterCompanyId,
        is_master_owner: true,
        invite_method: "Platform Admin",
        is_active: isActive,
        updated_at: new Date().toISOString()
      }, { onConflict: "id" });
    if (error) throw new Error(error.message);

    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Control panel user updated." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to update control panel user." });
  }
}

export async function deleteControlPanelUser(formData: FormData) {
  const authorization = await requirePlatformAdmin("edit");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "User");
    if (authorization.userId === id) throw new Error("You cannot delete your own control panel access.");

    const { data: profile, error: loadError } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", id)
      .maybeSingle();
    if (loadError) throw new Error(loadError.message);
    if (String(profile?.email ?? "").toLowerCase() === "nisar@dropxlogistics.com") {
      throw new Error("The primary platform owner cannot be deleted.");
    }

    const { error } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", id)
      .eq("is_master_owner", true);
    if (error) throw new Error(error.message);

    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Control panel user deleted." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to delete control panel user." });
  }
}

export async function createPlatformCompany(formData: FormData) {
  await requirePlatformAdmin("add");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const code = normalizeCompanyCode(required(formData.get("code"), "Company code"));
    if (!code) throw new Error("Company code is required.");
    const name = required(formData.get("name"), "Company name").toUpperCase();
    const adminName = required(formData.get("admin_name"), "Admin name");
    const adminEmail = normalizeEmail(formData.get("admin_email"));
    const adminMobile = normalizeMobile(formData.get("admin_mobile"));
    if (!adminEmail) throw new Error("Admin email is required.");
    if (!adminMobile) throw new Error("Admin mobile is required.");
    await assertEmailCanBelongToCompany(adminEmail, "", "Admin email");

    const { data, error } = await supabaseAdmin
      .from("companies")
      .insert({
        code,
        name,
        admin_name: adminName,
        admin_email: adminEmail,
        admin_mobile: adminMobile,
        webhook_key: makeWebhookKey(code),
        is_master: false,
        is_active: true
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error("Company created but ID was not returned.");

    try {
      await saveModuleAccess(data.id, formData);
      await ensureCompanyAdminProfile(data.id, adminName, adminEmail, adminMobile);
    } catch (setupError) {
      await supabaseAdmin.from("company_module_access").delete().eq("company_id", data.id);
      await supabaseAdmin.from("companies").delete().eq("id", data.id).eq("is_master", false);
      throw setupError;
    }
    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Company added." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to add company." });
  }
}

export async function deletePlatformCompany(formData: FormData) {
  await requirePlatformAdmin("edit");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Company");

    const { data: company, error: loadError } = await supabaseAdmin
      .from("companies")
      .select("name, is_master")
      .eq("id", id)
      .maybeSingle();
    if (loadError) throw new Error(loadError.message);
    if (!company) throw new Error("Company was not found.");
    if (company.is_master) throw new Error("The master company cannot be deleted.");

    await deleteCompanyScopedSettings(id);

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("company_id", id)
      .eq("is_master_owner", false);
    if (profileError) throw new Error(profileError.message);

    const { error: moduleError } = await supabaseAdmin
      .from("company_module_access")
      .delete()
      .eq("company_id", id);
    if (moduleError) throw new Error(moduleError.message);

    const { error } = await supabaseAdmin
      .from("companies")
      .delete()
      .eq("id", id)
      .eq("is_master", false);
    if (error) throw new Error(error.message);

    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Company deleted." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to delete company." });
  }
}

export async function updatePlatformCompany(formData: FormData) {
  await requirePlatformAdmin("edit");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Company");
    const code = normalizeCompanyCode(required(formData.get("code"), "Company code"));
    const name = required(formData.get("name"), "Company name").toUpperCase();
    const adminName = required(formData.get("admin_name"), "Admin name");
    const adminEmail = normalizeEmail(formData.get("admin_email"));
    const adminMobile = normalizeMobile(formData.get("admin_mobile"));
    if (!adminEmail) throw new Error("Admin email is required.");
    if (!adminMobile) throw new Error("Admin mobile is required.");
    const isActive = clean(formData.get("status")) !== "inactive";
    await assertEmailCanBelongToCompany(adminEmail, id, "Admin email");

    const { error } = await supabaseAdmin
      .from("companies")
      .update({
        code,
        name,
        admin_name: adminName,
        admin_email: adminEmail,
        admin_mobile: adminMobile,
        is_active: isActive,
        updated_at: new Date().toISOString()
      })
      .eq("id", id);
    if (error) throw new Error(error.message);

    await saveModuleAccess(id, formData);
    if (isActive) {
      await ensureCompanyAdminProfile(id, adminName, adminEmail, adminMobile);
    }
    revalidatePath("/platform-admin");
    platformRedirect({ notice: "Company updated." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    platformRedirect({ error: error instanceof Error ? error.message : "Unable to update company." });
  }
}
