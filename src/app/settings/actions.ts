"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { indiaStateCode } from "@/lib/india-states";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function optionalCoordinate(value: FormDataEntryValue | null, field: string, min: number, max: number) {
  const text = clean(value);
  if (!text) return null;

  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }

  return numberValue;
}

function optionalGeofenceRadius(value: FormDataEntryValue | null) {
  const text = clean(value);
  if (!text) return 50;
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue < 10 || numberValue > 5000) {
    throw new Error("Geofence radius must be between 10 and 5000 meters");
  }
  return Math.round(numberValue);
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isMissingSchemaError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("does not exist") || normalized.includes("could not find") || normalized.includes("schema cache");
}

type StationResponsibilityCode =
  | "station_manager"
  | "cluster_manager"
  | "regional_manager"
  | "ops_program_manager";

async function syncStationResponsibilities(input: {
  stationId: string;
  companyId: string;
  assignedBy: string;
  assignments: Record<StationResponsibilityCode, string | null>;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const activeResult = await supabaseAdmin
    .from("station_responsibility_assignments")
    .select("id, responsibility_code, assignee_email")
    .eq("company_id", input.companyId)
    .eq("station_id", input.stationId)
    .is("effective_to", null);
  if (activeResult.error) {
    if (isMissingSchemaError(activeResult.error.message)) return;
    throw new Error(activeResult.error.message);
  }

  const activeByCode = new Map(
    (activeResult.data ?? []).map((row) => [String(row.responsibility_code), row])
  );

  for (const [responsibilityCode, rawEmail] of Object.entries(input.assignments)) {
    const email = normalizeEmail(rawEmail) || null;
    const active = activeByCode.get(responsibilityCode);
    if (normalizeEmail(active?.assignee_email) === email) continue;

    if (active?.id) {
      const closeResult = await supabaseAdmin
        .from("station_responsibility_assignments")
        .update({ effective_to: new Date().toISOString() })
        .eq("id", active.id)
        .eq("company_id", input.companyId);
      if (closeResult.error) throw new Error(closeResult.error.message);
    }

    if (!email) continue;
    const profile = await findProfileByEmail(email, input.companyId);
    const insertResult = await supabaseAdmin
      .from("station_responsibility_assignments")
      .insert({
        company_id: input.companyId,
        station_id: input.stationId,
        responsibility_code: responsibilityCode,
        assignee_user_id: profile?.id ?? null,
        assignee_email: email,
        assigned_by: input.assignedBy
      });
    if (insertResult.error) throw new Error(insertResult.error.message);
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("") + "Aa1!";
}

function isExistingUserError(message: string) {
  const text = message.toLowerCase();
  return text.includes("already") || text.includes("registered") || text.includes("exists");
}

type ProfileAccessRow = {
  id: string;
  email: string | null;
  role_id: string | null;
  reports_to_user_id: string | null;
  location_scope_ids: string[] | null;
  company_id?: string | null;
};

function masterLocationRedirect(params: { error?: string; notice?: string }): never {
  const query = new URLSearchParams();
  if (params.error) query.set("locationError", params.error);
  if (params.notice) query.set("locationNotice", params.notice);
  redirect(`/master/location${query.toString() ? `?${query.toString()}` : ""}`);
}

async function findProfileByEmail(email: string, companyId?: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const normalizedEmail = normalizeEmail(email);
  const { data: exactProfile, error: exactError } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role, role_id, location_scope_ids, invite_method, company_id")
    .ilike("email", normalizedEmail)
    .eq("company_id", companyId ?? "")
    .maybeSingle();
  if (exactError) throw new Error(exactError.message);
  if (exactProfile) return exactProfile;

  const { data: profiles, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role, role_id, location_scope_ids, invite_method, company_id")
    .eq("company_id", companyId ?? "")
    .not("email", "is", null);
  if (error) throw new Error(error.message);

  return (profiles ?? []).find((profile) => normalizeEmail(profile.email) === normalizedEmail) ?? null;
}

async function findProfileById(id: string, companyId?: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role, role_id, location_scope_ids, invite_method, company_id")
    .eq("id", id)
    .eq("company_id", companyId ?? "")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function findAuthUserIdByEmail(email: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const normalizedEmail = normalizeEmail(email);

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(error.message);

    const match = data.users.find((user) => normalizeEmail(user.email) === normalizedEmail);
    if (match?.id) return match.id;
    if (data.users.length < 100) break;
  }

  return null;
}

async function ensureAuthUserForLocationEmail(email: string, fullName: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const existingUserId = await findAuthUserIdByEmail(email);
  if (existingUserId) return existingUserId;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: randomPassword(),
    email_confirm: true,
    user_metadata: { full_name: fullName, login_source: "location_email" }
  });

  if (error) {
    if (isExistingUserError(error.message)) {
      const userId = await findAuthUserIdByEmail(email);
      if (userId) return userId;
    }
    throw new Error(error.message);
  }

  if (!data.user?.id) throw new Error("Location email auth user could not be created.");
  return data.user.id;
}

async function ensureLocationRole(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const { data: role, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("code", "LOCATION")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (role?.id) {
    const { error: updateError } = await supabaseAdmin
      .from("user_roles")
      .update({
        parent_role_id: null,
        location_access_mode: "role_based",
        is_active: true
      })
      .eq("id", role.id)
      .eq("company_id", companyId);
    if (updateError) throw new Error(updateError.message);
    return role.id as string;
  }

  const { data: createdRole, error: createError } = await supabaseAdmin
    .from("user_roles")
    .insert({
      code: "LOCATION",
      name: "Location",
      company_id: companyId,
      parent_role_id: null,
      location_access_mode: "role_based",
      is_active: true,
      is_system: false
    })
    .select("id")
    .single();
  if (createError) throw new Error(createError.message);
  return createdRole.id as string;
}

async function syncLocationEmailProfile(
  locationId: string,
  stationEmail: string | null,
  stationName: string,
  managerEmail: string,
  companyId: string
) {
  if (!supabaseAdmin || !stationEmail) return;

  const email = normalizeEmail(stationEmail);
  if (!email) return;
  if (!email.endsWith("@dropxlogistics.com")) {
    throw new Error("Location email must be a @dropxlogistics.com email.");
  }

  const roleId = await ensureLocationRole(companyId);
  const manager = await findProfileByEmail(managerEmail, companyId);
  const existingProfile = await findProfileByEmail(email, companyId);
  const authUserId = existingProfile?.id ?? await ensureAuthUserForLocationEmail(email, stationName);
  const profile = existingProfile ?? await findProfileById(authUserId, companyId) ?? await findProfileByEmail(email, companyId);
  const nextScope = Array.from(new Set([...(profile?.location_scope_ids ?? []), locationId]));
  const isLocationManagedProfile = ["Location Email", "Location Master"].includes(profile?.invite_method ?? "");
  const isManualProfile = Boolean(profile?.role_id) && !isLocationManagedProfile;
  if (existingProfile && profile && isManualProfile) {
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ location_scope_ids: nextScope, company_id: profile.company_id ?? companyId })
      .eq("id", profile.id);
    if (error) throw new Error(`Location saved, but existing user location scope could not be updated: ${error.message}`);
    return;
  }

  const payload = {
    full_name: profile?.full_name || stationName,
    email,
    role_id: roleId,
    reports_to_user_id: manager?.id ?? null,
    location_scope_ids: nextScope,
    company_id: companyId,
    invite_method: "Location Master",
    is_active: true
  };

  const { error } = profile
    ? await supabaseAdmin.from("profiles").update(payload).eq("id", profile.id)
    : await supabaseAdmin.from("profiles").insert({ id: authUserId, ...payload });

  if (error) {
    const recoveredProfile = await findProfileById(authUserId, companyId) ?? await findProfileByEmail(email, companyId);
    if (recoveredProfile?.id) {
      const recoveredIsLocationManaged = ["Location Email", "Location Master"].includes(recoveredProfile.invite_method ?? "");
      const recoveredIsManualProfile = Boolean(recoveredProfile.role_id) && !recoveredIsLocationManaged;
      if (recoveredIsManualProfile) {
        const { error: scopeOnlyError } = await supabaseAdmin
          .from("profiles")
          .update({
            location_scope_ids: Array.from(new Set([...(recoveredProfile.location_scope_ids ?? []), locationId])),
            company_id: recoveredProfile.company_id ?? companyId
          })
          .eq("id", recoveredProfile.id);
        if (!scopeOnlyError) return;
        throw new Error(`Location saved, but existing user location scope could not be updated: ${scopeOnlyError.message}`);
      }

      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update(payload)
        .eq("id", recoveredProfile.id);
      if (!updateError) return;
      throw new Error(`Location saved, but location email login could not be synced: ${updateError.message}`);
    }
    throw new Error(`Location saved, but location email login could not be synced: ${error.message}`);
  }
}

async function trySyncLocationEmailProfile(
  locationId: string,
  stationEmail: string | null,
  stationName: string,
  managerEmail: string,
  companyId: string
) {
  try {
    await syncLocationEmailProfile(locationId, stationEmail, stationName, managerEmail, companyId);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Location email login sync skipped: ${message}`);
    return message;
  }
}

async function removeLocationEmailProfileScope(locationId: string, stationEmail: string | null, companyId: string) {
  if (!supabaseAdmin || !stationEmail) return;

  const profile = await findProfileByEmail(stationEmail, companyId);
  if (!profile || !["Location Email", "Location Master"].includes(profile.invite_method ?? "")) return;

  const nextScope = (profile.location_scope_ids ?? []).filter((id: string) => id !== locationId);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      location_scope_ids: nextScope,
      is_active: nextScope.length > 0
    })
    .eq("id", profile.id)
    .eq("company_id", companyId);

  if (error) throw new Error(`Old location email access could not be updated: ${error.message}`);
}

async function locationAccessProfiles(managerEmail: string, companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const [profilesResult, allLocationRolesResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, email, role_id, reports_to_user_id, location_scope_ids")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("company_id", companyId)
      .eq("location_access_mode", "all_locations")
  ]);

  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (allLocationRolesResult.error) throw new Error(allLocationRolesResult.error.message);

  const profiles = (profilesResult.data ?? []) as ProfileAccessRow[];
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const selectedManager = profiles.find(
    (profile) => profile.email?.trim().toLowerCase() === managerEmail.trim().toLowerCase()
  );

  if (!selectedManager) throw new Error("Selected manager was not found in the user list.");

  const allLocationRoleIds = new Set((allLocationRolesResult.data ?? []).map((role) => role.id));
  const accessProfileIds = new Set(
    profiles
      .filter((profile) => profile.role_id && allLocationRoleIds.has(profile.role_id))
      .map((profile) => profile.id)
  );
  const visited = new Set<string>();
  let current: ProfileAccessRow | undefined = selectedManager;

  while (current) {
    if (visited.has(current.id)) {
      throw new Error("The reporting-manager hierarchy contains a loop. Correct it before assigning this location.");
    }

    visited.add(current.id);
    accessProfileIds.add(current.id);
    current = current.reports_to_user_id ? profilesById.get(current.reports_to_user_id) : undefined;
  }

  return profiles.filter((profile) => accessProfileIds.has(profile.id));
}

async function addLocationAccess(locationId: string, profiles: ProfileAccessRow[], companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const admin = supabaseAdmin;

  await Promise.all(profiles.map(async (profile) => {
    const currentScope = profile.location_scope_ids ?? [];
    if (currentScope.includes(locationId)) return;

    const { error } = await admin
      .from("profiles")
      .update({ location_scope_ids: [...currentScope, locationId] })
      .eq("id", profile.id)
      .eq("company_id", companyId);

    if (error) throw new Error(`Location saved, but user access could not be updated: ${error.message}`);
  }));
}

async function countLocationDependencyRows(
  table: string,
  filters: Record<string, string>,
  companyId?: string
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  let query = supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (companyId) query = query.eq("company_id", companyId);

  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });

  const { count, error } = await query;
  if (error) {
    if (isMissingSchemaError(error.message)) return 0;
    throw new Error(error.message);
  }

  return count ?? 0;
}

async function removeLocationAccessFromProfiles(locationId: string, companyId: string, excludedEmail: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const admin = supabaseAdmin;
  const normalizedExcludedEmail = normalizeEmail(excludedEmail);

  const { data, error } = await admin
    .from("profiles")
    .select("id, email, location_scope_ids")
    .eq("company_id", companyId)
    .contains("location_scope_ids", [locationId]);

  if (error) throw new Error(`Location access could not be cleaned up: ${error.message}`);

  await Promise.all((data ?? []).map(async (profile) => {
    if (normalizeEmail(profile.email) === normalizedExcludedEmail) return;

    const nextScope = ((profile.location_scope_ids ?? []) as string[]).filter((id) => id !== locationId);
    const { error: updateError } = await admin
      .from("profiles")
      .update({ location_scope_ids: nextScope })
      .eq("id", profile.id)
      .eq("company_id", companyId);

    if (updateError) throw new Error(`Location access could not be cleaned up: ${updateError.message}`);
  }));
}

export async function createProvider(formData: FormData) {
  const authorization = await requirePagePermission("master_providers", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const code = required(formData.get("code"), "Provider code").toUpperCase();
  const name = required(formData.get("name"), "Provider name");
  const isActive = formData.get("is_active") !== "inactive";

  const { error } = await supabaseAdmin.from("providers").insert(withCompany({
    code,
    name,
    is_active: isActive
  }, companyId));

  if (error) throw new Error(error.message);
  revalidatePath("/master/providers");
}

export async function updateProvider(formData: FormData) {
  const authorization = await requirePagePermission("master_providers", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "Provider ID");
  const code = required(formData.get("code"), "Provider code").toUpperCase();
  const name = required(formData.get("name"), "Provider name");
  const isActive = formData.get("is_active") !== "inactive";

  const { error } = await supabaseAdmin
    .from("providers")
    .update({ code, name, is_active: isActive })
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
  revalidatePath("/master/providers");
  redirect("/master/providers");
}

export async function createLocationModel(formData: FormData) {
  const authorization = await requirePagePermission("master_models", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const providerId = required(formData.get("provider_id"), "Provider");
  const code = required(formData.get("code"), "Model code").toUpperCase();
  const name = required(formData.get("name"), "Model name");
  const description = clean(formData.get("description"));

  const { error } = await supabaseAdmin.from("location_models").insert(withCompany({
    provider_id: providerId,
    code,
    name,
    description,
    is_active: true
  }, companyId));

  if (error) throw new Error(error.message);
  revalidatePath("/master/models");
}

export async function updateLocationModel(formData: FormData) {
  const authorization = await requirePagePermission("master_models", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "Model ID");
  const providerId = required(formData.get("provider_id"), "Provider");
  const code = required(formData.get("code"), "Model code").toUpperCase();
  const name = required(formData.get("name"), "Model name");
  const description = clean(formData.get("description"));
  const isActive = formData.get("is_active") !== "inactive";

  const { error } = await supabaseAdmin
    .from("location_models")
    .update({
      provider_id: providerId,
      code,
      name,
      description,
      is_active: isActive
    })
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
  revalidatePath("/master/models");
  redirect("/master/models");
}

export async function createLocation(formData: FormData) {
  const authorization = await requirePagePermission("master_locations", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const stationCode = required(formData.get("station_code"), "Location code").toUpperCase();
  const stationName = required(formData.get("station_name"), "Location name");
  const providerId = clean(formData.get("provider_id"));
  const locationModelId = clean(formData.get("location_model_id"));
  const addressLine1 = required(formData.get("address_line1"), "Address line 1");
  const addressLine2 = clean(formData.get("address_line2"));
  const city = clean(formData.get("city"));
  const state = indiaStateCode(required(formData.get("state"), "State"));
  if (!state) throw new Error("Select a valid state");
  const postalCode = clean(formData.get("postal_code"));
  const latitude = optionalCoordinate(formData.get("latitude"), "Latitude", -90, 90);
  const longitude = optionalCoordinate(formData.get("longitude"), "Longitude", -180, 180);
  const geofenceRadiusM = optionalGeofenceRadius(formData.get("geofence_radius_m"));
  const stationEmail = clean(formData.get("station_email"));
  const parentStationId = clean(formData.get("parent_station_id"));
  const stationManagerEmail = required(formData.get("station_manager_email"), "Manager").toLowerCase();
  const clusterManagerEmail = normalizeEmail(clean(formData.get("cluster_manager_email"))) || null;
  const regionalManagerEmail = normalizeEmail(clean(formData.get("ops_manager_email"))) || null;
  const opsProgramManagerEmail = normalizeEmail(clean(formData.get("ops_program_manager_email"))) || null;
  const region = clean(formData.get("region"));
  const cluster = clean(formData.get("cluster"));
  const stationReportingEmail = stationManagerEmail;
  const hideFromLocationList = formData.get("hide_from_location_list") === "on";
  const address = [addressLine1, addressLine2, city, state, postalCode].filter(Boolean).join(", ");
  const accessProfiles = await locationAccessProfiles(stationReportingEmail, companyId);

  const payload = withCompany({
    station_code: stationCode,
    station_name: stationName,
    provider_id: providerId,
    location_model_id: locationModelId,
    address,
    address_line1: addressLine1,
    address_line2: addressLine2,
    city,
    state,
    region,
    cluster,
    postal_code: postalCode,
    latitude,
    longitude,
    geofence_radius_m: geofenceRadiusM,
    station_email: stationEmail,
    station_manager_email: stationManagerEmail,
    cluster_manager_email: clusterManagerEmail,
    ops_manager_email: regionalManagerEmail,
    ops_program_manager_email: opsProgramManagerEmail,
    parent_station_id: parentStationId,
    hide_from_location_list: hideFromLocationList,
    is_active: true
  }, companyId);
  let { data: location, error } = await supabaseAdmin.from("stations").insert(payload).select("id").single();
  if (error && /geofence_radius_m|ops_program_manager_email|does not exist|schema cache/i.test(error.message)) {
    const { geofence_radius_m: _radius, ops_program_manager_email: _programManager, ...legacyPayload } = payload as Record<string, unknown>;
    const fallback = await supabaseAdmin.from("stations").insert(legacyPayload).select("id").single();
    location = fallback.data;
    error = fallback.error;
  }

  if (error) throw new Error(error.message);
  if (!location) throw new Error("Unable to create location.");
  await syncStationResponsibilities({
    stationId: location.id,
    companyId,
    assignedBy: authorization.userId,
    assignments: {
      station_manager: stationManagerEmail,
      cluster_manager: clusterManagerEmail,
      regional_manager: regionalManagerEmail,
      ops_program_manager: opsProgramManagerEmail
    }
  });
  await addLocationAccess(location.id, accessProfiles, companyId);
  const syncError = await trySyncLocationEmailProfile(location.id, stationEmail, stationName, stationReportingEmail, companyId);
  revalidatePath("/master/location");
  revalidatePath("/users");
  if (syncError) {
    masterLocationRedirect({ error: syncError });
  }
}

export async function updateLocation(formData: FormData) {
  const authorization = await requirePagePermission("master_locations", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "Location ID");
  const stationCode = required(formData.get("station_code"), "Location code").toUpperCase();
  const stationName = required(formData.get("station_name"), "Location name");
  const providerId = clean(formData.get("provider_id"));
  const locationModelId = clean(formData.get("location_model_id"));
  const addressLine1 = required(formData.get("address_line1"), "Address line 1");
  const addressLine2 = clean(formData.get("address_line2"));
  const city = clean(formData.get("city"));
  const state = indiaStateCode(required(formData.get("state"), "State"));
  if (!state) throw new Error("Select a valid state");
  const postalCode = clean(formData.get("postal_code"));
  const latitude = optionalCoordinate(formData.get("latitude"), "Latitude", -90, 90);
  const longitude = optionalCoordinate(formData.get("longitude"), "Longitude", -180, 180);
  const geofenceRadiusM = optionalGeofenceRadius(formData.get("geofence_radius_m"));
  const stationEmail = clean(formData.get("station_email"));
  const parentStationId = clean(formData.get("parent_station_id"));
  const stationManagerEmail = required(formData.get("station_manager_email"), "Manager").toLowerCase();
  const clusterManagerEmail = normalizeEmail(clean(formData.get("cluster_manager_email"))) || null;
  const regionalManagerEmail = normalizeEmail(clean(formData.get("ops_manager_email"))) || null;
  const opsProgramManagerEmail = normalizeEmail(clean(formData.get("ops_program_manager_email"))) || null;
  const region = clean(formData.get("region"));
  const cluster = clean(formData.get("cluster"));
  const stationReportingEmail = stationManagerEmail;
  const isActive = formData.get("is_active") !== "inactive";
  const hideFromLocationList = formData.get("hide_from_location_list") === "on";
  const address = [addressLine1, addressLine2, city, state, postalCode].filter(Boolean).join(", ");
  const accessProfiles = await locationAccessProfiles(stationReportingEmail, companyId);
  const { data: existingLocation, error: existingLocationError } = await supabaseAdmin
    .from("stations")
    .select("station_email")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (existingLocationError) throw new Error(existingLocationError.message);

  const updatePayload = {
      station_code: stationCode,
      station_name: stationName,
      provider_id: providerId,
      location_model_id: locationModelId,
      address,
      address_line1: addressLine1,
      address_line2: addressLine2,
      city,
      state,
      region,
      cluster,
      postal_code: postalCode,
      latitude,
      longitude,
      geofence_radius_m: geofenceRadiusM,
      station_email: stationEmail,
      station_manager_email: stationManagerEmail,
      cluster_manager_email: clusterManagerEmail,
      ops_manager_email: regionalManagerEmail,
      ops_program_manager_email: opsProgramManagerEmail,
      parent_station_id: parentStationId,
      hide_from_location_list: hideFromLocationList,
      is_active: isActive
    };
  let { error } = await supabaseAdmin
    .from("stations")
    .update(updatePayload)
    .eq("id", id)
    .eq("company_id", companyId);
  if (error && /geofence_radius_m|ops_program_manager_email|does not exist|schema cache/i.test(error.message)) {
    const { geofence_radius_m: _radius, ops_program_manager_email: _programManager, ...legacyPayload } = updatePayload;
    const fallback = await supabaseAdmin
      .from("stations")
      .update(legacyPayload)
      .eq("id", id)
      .eq("company_id", companyId);
    error = fallback.error;
  }

  if (error) throw new Error(error.message);
  await syncStationResponsibilities({
    stationId: id,
    companyId,
    assignedBy: authorization.userId,
    assignments: {
      station_manager: stationManagerEmail,
      cluster_manager: clusterManagerEmail,
      regional_manager: regionalManagerEmail,
      ops_program_manager: opsProgramManagerEmail
    }
  });
  await addLocationAccess(id, accessProfiles, companyId);
  if (normalizeEmail(existingLocation?.station_email) !== normalizeEmail(stationEmail)) {
    await removeLocationEmailProfileScope(id, existingLocation?.station_email ?? null, companyId);
  }
  if (isActive) {
    const syncError = await trySyncLocationEmailProfile(id, stationEmail, stationName, stationReportingEmail, companyId);
    if (syncError) {
      revalidatePath("/master/location");
      revalidatePath("/users");
      masterLocationRedirect({ error: syncError });
    }
  } else {
    await removeLocationEmailProfileScope(id, stationEmail, companyId);
  }
  revalidatePath("/master/location");
  revalidatePath("/users");
  redirect("/master/location");
}

export async function deleteLocation(formData: FormData) {
  const authorization = await requirePagePermission("master_locations", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "Location ID");
  const { data: location, error: locationError } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, station_email")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();

  if (locationError) throw new Error(locationError.message);
  if (!location) masterLocationRedirect({ error: "Location not found." });

  const [fieldExecutiveCount, mappingCount, fleetVehicleCount] = await Promise.all([
    countLocationDependencyRows("field_executives", { location_id: id }),
    countLocationDependencyRows("provider_id_mappings", { station_id: id }),
    countLocationDependencyRows("fleet_vehicles", { station_code: location.station_code }, companyId)
  ]);

  const blockers = [
    fieldExecutiveCount ? pluralize(fieldExecutiveCount, "field executive") : null,
    mappingCount ? pluralize(mappingCount, "provider mapping") : null,
    fleetVehicleCount ? pluralize(fleetVehicleCount, "fleet vehicle") : null
  ].filter(Boolean);

  if (blockers.length > 0) {
    masterLocationRedirect({
      error: `Location ${location.station_code} cannot be deleted because it is used in ${blockers.join(", ")}.`
    });
  }

  await removeLocationEmailProfileScope(id, location.station_email ?? null, companyId);
  await removeLocationAccessFromProfiles(id, companyId, location.station_email ?? null);

  const { error } = await supabaseAdmin
    .from("stations")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) {
    masterLocationRedirect({ error: `Location could not be deleted: ${error.message}` });
  }

  revalidatePath("/master/location");
  revalidatePath("/users");
  masterLocationRedirect({ notice: "Location deleted." });
}
