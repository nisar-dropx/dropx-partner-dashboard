import "server-only";

import { randomBytes } from "crypto";
import { sendEmail } from "@/lib/email";
import {
  GoogleWorkspaceApiError,
  GoogleWorkspaceClient,
  type GoogleDirectoryUser,
  workspaceCredentialsConfigured
} from "@/lib/google-workspace-client";
import { supabaseAdmin } from "@/lib/supabase-admin";

type WorkspaceSettingRow = {
  company_id: string;
  customer_id: string | null;
  primary_domain: string;
  delegated_admin_email: string | null;
  default_org_unit_path: string;
  directory_sync_enabled: boolean;
  provisioning_enabled: boolean;
  automatic_suspension_enabled: boolean;
  default_retention_days: number;
};

type WorkspacePolicyRow = {
  id: string;
  company_id: string;
  designation_id: string;
  issue_workspace_account: boolean;
  approval_mode: "automatic" | "manual";
  email_pattern: string;
  org_unit_path: string;
  group_emails: string[];
  access_role_id: string | null;
  product_codes: string[];
  location_access_mode: "assignment" | "all_locations" | "none";
  send_activation_email: boolean;
  retention_days: number | null;
  is_active: boolean;
};

type WorkspaceAccountRow = {
  id: string;
  company_id: string;
  google_user_id: string | null;
  primary_email: string;
  full_name: string;
  org_unit_path: string;
  account_type: "person" | "location" | "service" | "unmatched";
  account_state: string;
  source_type: string | null;
  source_record_id: string | null;
  person_id: string | null;
  profile_id: string | null;
  designation_id: string | null;
  location_id: string | null;
  group_emails: string[];
  suspended: boolean;
  deletion_eligible_at: string | null;
  metadata: Record<string, unknown>;
};

type WorkspaceJobRow = {
  id: string;
  company_id: string;
  account_id: string | null;
  job_type: "directory_sync" | "provision" | "update_access" | "suspend" | "restore" | "delete";
  status: string;
  source_type: string | null;
  source_record_id: string | null;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  requested_by: string | null;
};

type EmployeeSource = {
  id: string;
  companyId: string;
  fullName: string;
  personalEmail: string | null;
  employeeCode: string | null;
  designationId: string;
  designationCode: string | null;
  locationId: string | null;
  locationCode: string | null;
  active: boolean;
  personId: string | null;
};

function db() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => normalizeEmail(item)).filter(Boolean) : [];
}

function isMissingRelationError(error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return ["42P01", "PGRST204", "PGRST205"].includes(code) ||
    (message.includes("does not exist") || message.includes("schema cache"));
}

async function loadSettings(companyId: string, requireEnabled = false) {
  const result = await db().from("google_workspace_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const setting = result.data as WorkspaceSettingRow | null;
  if (!setting) throw new Error("Google Workspace connection settings are not configured.");
  if (!setting.delegated_admin_email) throw new Error("The delegated Google Workspace administrator is not configured.");
  if (requireEnabled && !setting.provisioning_enabled) throw new Error("Google Workspace provisioning is disabled in the connection master.");
  if (!workspaceCredentialsConfigured()) throw new Error("Google Workspace workload identity is not configured for this deployment.");
  return setting;
}

function clientFor(setting: WorkspaceSettingRow) {
  return new GoogleWorkspaceClient({
    customerId: setting.customer_id,
    delegatedAdminEmail: setting.delegated_admin_email!,
    primaryDomain: setting.primary_domain
  });
}

async function audit(input: {
  companyId: string;
  accountId?: string | null;
  jobId?: string | null;
  actorId?: string | null;
  action: string;
  status: "requested" | "success" | "failed" | "blocked" | "cancelled";
  detail?: Record<string, unknown>;
}) {
  await db().from("google_workspace_audit_log").insert({
    company_id: input.companyId,
    account_id: input.accountId ?? null,
    job_id: input.jobId ?? null,
    actor_user_id: input.actorId ?? null,
    action: input.action,
    status: input.status,
    detail: input.detail ?? {}
  });
}

async function getAccount(accountId: string) {
  const result = await db().from("google_workspace_accounts").select("*").eq("id", accountId).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Google Workspace account mapping was not found.");
  return result.data as WorkspaceAccountRow;
}

async function getPolicy(companyId: string, designationId: string) {
  const result = await db().from("google_workspace_designation_policies").select("*")
    .eq("company_id", companyId).eq("designation_id", designationId).eq("is_active", true).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data as WorkspacePolicyRow | null;
}

async function employeeSource(companyId: string, employeeId: string): Promise<EmployeeSource> {
  const result = await db().from("employees")
    .select("id,company_id,full_name,email,employee_code,designation_id,location_id,is_active,designations(code),stations(station_code)")
    .eq("company_id", companyId).eq("id", employeeId).maybeSingle();
  if (result.error || !result.data?.designation_id) throw new Error(result.error?.message ?? "Employee or designation was not found.");
  const designation = Array.isArray(result.data.designations) ? result.data.designations[0] : result.data.designations;
  const station = Array.isArray(result.data.stations) ? result.data.stations[0] : result.data.stations;
  let personId: string | null = null;
  const engagement = await db().from("hr_engagements").select("person_id")
    .eq("company_id", companyId).eq("employee_id", employeeId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!engagement.error) personId = engagement.data?.person_id ?? null;
  else if (!isMissingRelationError(engagement.error)) throw new Error(engagement.error.message);
  return {
    id: result.data.id,
    companyId,
    fullName: result.data.full_name,
    personalEmail: normalizeEmail(result.data.email) || null,
    employeeCode: result.data.employee_code,
    designationId: result.data.designation_id,
    designationCode: designation?.code ?? null,
    locationId: result.data.location_id,
    locationCode: station?.station_code ?? null,
    active: Boolean(result.data.is_active),
    personId
  };
}

async function contractorSource(companyId: string, contractorId: string): Promise<EmployeeSource> {
  const result = await db().from("contractors")
    .select("id,company_id,full_name,email,dropx_id,designation,location_id,is_active,stations(station_code)")
    .eq("company_id", companyId).eq("id", contractorId).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Contractor was not found.");
  const station = Array.isArray(result.data.stations) ? result.data.stations[0] : result.data.stations;
  const engagement = await db().from("hr_engagements").select("id,person_id")
    .eq("company_id", companyId).eq("contractor_id", contractorId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error && !isMissingRelationError(engagement.error)) throw new Error(engagement.error.message);
  const assignment = engagement.data?.id ? await db().from("hr_work_assignments").select("designation_id")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle() : { data: null, error: null };
  if (assignment.error && !isMissingRelationError(assignment.error)) throw new Error(assignment.error.message);
  let designationId = assignment.data?.designation_id ?? null;
  let designationCode: string | null = null;
  if (designationId) {
    const designation = await db().from("designations").select("code").eq("company_id", companyId).eq("id", designationId).maybeSingle();
    if (designation.error) throw new Error(designation.error.message);
    designationCode = designation.data?.code ?? null;
  } else if (result.data.designation) {
    const designation = await db().from("designations").select("id,code").eq("company_id", companyId).ilike("name", result.data.designation).eq("is_active", true).limit(1).maybeSingle();
    if (designation.error) throw new Error(designation.error.message);
    designationId = designation.data?.id ?? null;
    designationCode = designation.data?.code ?? null;
  }
  if (!designationId) throw new Error("The contractor has no active designation mapping for Workspace restoration.");
  return {
    id: result.data.id,
    companyId,
    fullName: result.data.full_name,
    personalEmail: normalizeEmail(result.data.email) || null,
    employeeCode: result.data.dropx_id,
    designationId,
    designationCode,
    locationId: result.data.location_id,
    locationCode: station?.station_code ?? null,
    active: Boolean(result.data.is_active),
    personId: engagement.data?.person_id ?? null
  };
}

async function workerSource(companyId: string, sourceRecordId: string, sourceType: string | null) {
  return sourceType === "contractor"
    ? contractorSource(companyId, sourceRecordId)
    : employeeSource(companyId, sourceRecordId);
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const givenName = parts[0] || "DropX";
  const familyName = parts.slice(1).join(" ") || "Team";
  return { givenName, familyName };
}

function emailToken(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
}

function emailLocalPart(pattern: string, source: EmployeeSource) {
  const { givenName, familyName } = splitName(source.fullName);
  const replacements: Record<string, string> = {
    "{first}": emailToken(givenName),
    "{last}": emailToken(familyName),
    "{employee_code}": emailToken(source.employeeCode),
    "{designation_code}": emailToken(source.designationCode),
    "{location_code}": emailToken(source.locationCode)
  };
  let local = pattern.toLowerCase();
  for (const [token, value] of Object.entries(replacements)) local = local.replaceAll(token, value);
  local = emailToken(local).slice(0, 55);
  if (local.length < 3) local = `dropx.${emailToken(source.employeeCode || source.id.slice(0, 8))}`;
  return local;
}

function temporaryPassword() {
  return `${randomBytes(14).toString("base64url")}Aa1!`;
}

async function availableEmail(client: GoogleWorkspaceClient, domain: string, localPart: string, employeeCode: string | null) {
  const suffix = emailToken(employeeCode).slice(-8);
  const candidates = [
    localPart,
    suffix ? `${localPart}.${suffix}`.slice(0, 63) : "",
    `${localPart}.${randomBytes(3).toString("hex")}`.slice(0, 63)
  ].filter(Boolean);
  for (const candidate of candidates) {
    const email = `${candidate}@${domain}`;
    if (!await client.getUser(email)) return email;
  }
  throw new Error("A unique Google Workspace email address could not be generated.");
}

async function findAuthUserId(email: string) {
  for (let page = 1; page <= 30; page += 1) {
    const result = await db().auth.admin.listUsers({ page, perPage: 100 });
    if (result.error) throw new Error(result.error.message);
    const found = result.data.users.find((user) => normalizeEmail(user.email) === email);
    if (found) return found.id;
    if (result.data.users.length < 100) break;
  }
  return null;
}

async function linkedUserId(companyId: string, personId: string | null) {
  if (!personId) return null;
  const result = await db().from("hr_user_person_links").select("user_id")
    .eq("company_id", companyId).eq("person_id", personId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) {
    if (isMissingRelationError(result.error)) return null;
    throw new Error(result.error.message);
  }
  return result.data?.user_id ?? null;
}

async function ensureDropxAccess(input: {
  account: WorkspaceAccountRow;
  source: EmployeeSource;
  policy: WorkspacePolicyRow;
}) {
  const { account, source, policy } = input;
  if (!policy.access_role_id) return null;
  const officialEmail = normalizeEmail(account.primary_email);
  let userId = account.profile_id ?? await linkedUserId(source.companyId, source.personId);
  if (!userId) {
    const profile = await db().from("profiles").select("id").eq("company_id", source.companyId)
      .ilike("email", officialEmail).eq("is_active", true).limit(1).maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    userId = profile.data?.id ?? await findAuthUserId(officialEmail);
  }
  if (!userId) {
    const created = await db().auth.admin.createUser({
      email: officialEmail,
      email_confirm: true,
      password: temporaryPassword(),
      user_metadata: { full_name: source.fullName, provisioned_by: "google_workspace" }
    });
    if (created.error || !created.data.user) throw new Error(created.error?.message ?? "DropX login account could not be created.");
    userId = created.data.user.id;
  } else {
    const updated = await db().auth.admin.updateUserById(userId, {
      email: officialEmail,
      email_confirm: true,
      user_metadata: { full_name: source.fullName, provisioned_by: "google_workspace" }
    });
    if (updated.error) throw new Error(updated.error.message);
  }

  const role = await db().from("user_roles").select("id,code,location_access_mode")
    .eq("company_id", source.companyId).eq("id", policy.access_role_id).eq("is_active", true).maybeSingle();
  if (role.error || !role.data) throw new Error(role.error?.message ?? "The Workspace policy access role is inactive or unavailable.");
  const locationScopeIds = policy.location_access_mode === "assignment" && source.locationId ? [source.locationId] : [];
  const allLocations = policy.location_access_mode === "all_locations";

  const profileSave = await db().from("profiles").upsert({
    id: userId,
    company_id: source.companyId,
    email: officialEmail,
    full_name: source.fullName,
    role_id: policy.access_role_id,
    location_scope_ids: allLocations ? [] : locationScopeIds,
    invite_method: "Google Workspace",
    is_active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: "id" });
  if (profileSave.error) throw new Error(profileSave.error.message);

  if (source.personId) {
    const existingLink = await db().from("hr_user_person_links").select("id")
      .eq("company_id", source.companyId).eq("user_id", userId).maybeSingle();
    if (!existingLink.error) {
      const linkPayload = { company_id: source.companyId, user_id: userId, person_id: source.personId, status: "active", updated_at: new Date().toISOString() };
      const linkSave = existingLink.data
        ? await db().from("hr_user_person_links").update(linkPayload).eq("id", existingLink.data.id)
        : await db().from("hr_user_person_links").insert(linkPayload);
      if (linkSave.error) throw new Error(linkSave.error.message);
    } else if (!isMissingRelationError(existingLink.error)) throw new Error(existingLink.error.message);
  }

  for (const productCode of policy.product_codes) {
    const membership = await db().from("company_product_memberships").upsert({
      company_id: source.companyId,
      product_code: productCode,
      user_id: userId,
      role_id: policy.access_role_id,
      role_code_snapshot: role.data.code,
      source_system: "google_workspace",
      source_record_id: account.id,
      has_all_location_access: allLocations,
      location_scope_ids: allLocations ? [] : locationScopeIds,
      is_active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,product_code,user_id" });
    if (membership.error) throw new Error(membership.error.message);
  }
  const managedMemberships = await db().from("company_product_memberships").select("id,product_code")
    .eq("company_id", source.companyId).eq("user_id", userId).eq("source_system", "google_workspace");
  if (managedMemberships.error) throw new Error(managedMemberships.error.message);
  const staleIds = (managedMemberships.data ?? [])
    .filter((membership) => !policy.product_codes.includes(membership.product_code))
    .map((membership) => membership.id);
  if (staleIds.length) {
    const staleResult = await db().from("company_product_memberships")
      .update({ is_active: false, updated_at: new Date().toISOString() }).in("id", staleIds);
    if (staleResult.error) throw new Error(staleResult.error.message);
  }

  const includesPeople = policy.product_codes.includes("people");
  const peopleRole = await db().from("hr_roles").select("id,code").eq("company_id", source.companyId)
    .eq("central_role_id", policy.access_role_id).eq("is_active", true).maybeSingle();
  if (!peopleRole.error && peopleRole.data) {
    const peopleAccess = await db().from("hr_user_access").upsert({
      company_id: source.companyId,
      user_id: userId,
      role_id: peopleRole.data.id,
      role_code: role.data.code,
      location_ids: allLocations ? [] : locationScopeIds,
      all_locations: allLocations,
      is_active: includesPeople,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,user_id" });
    if (peopleAccess.error) throw new Error(peopleAccess.error.message);
  } else if (peopleRole.error && !isMissingRelationError(peopleRole.error)) {
    throw new Error(peopleRole.error.message);
  }

  const accountUpdate = await db().from("google_workspace_accounts").update({
    profile_id: userId,
    person_id: source.personId,
    designation_id: source.designationId,
    location_id: source.locationId,
    account_type: "person",
    updated_at: new Date().toISOString()
  }).eq("id", account.id);
  if (accountUpdate.error) throw new Error(accountUpdate.error.message);
  return userId;
}

async function syncManagedGroups(client: GoogleWorkspaceClient, account: WorkspaceAccountRow, desiredGroups: string[]) {
  const desired = new Set(desiredGroups.map(normalizeEmail).filter(Boolean));
  const managedBefore = new Set((account.group_emails ?? []).map(normalizeEmail).filter(Boolean));
  for (const group of desired) {
    if (managedBefore.has(group)) continue;
    try {
      await client.addGroupMember(group, account.primary_email);
    } catch (error) {
      if (!(error instanceof GoogleWorkspaceApiError && error.status === 409)) throw error;
    }
  }
  for (const group of managedBefore) {
    if (!desired.has(group)) await client.removeGroupMember(group, account.google_user_id ?? account.primary_email);
  }
}

async function saveDirectoryUser(companyId: string, user: GoogleDirectoryUser, retentionDays: number, existing?: WorkspaceAccountRow | null) {
  const email = normalizeEmail(user.primaryEmail);
  const [profileResult, stationResult] = await Promise.all([
    db().from("profiles").select("id").eq("company_id", companyId)
      .ilike("email", email).eq("is_active", true).limit(1).maybeSingle(),
    db().from("stations").select("id").eq("company_id", companyId)
      .ilike("station_email", email).eq("is_active", true).limit(1).maybeSingle()
  ]);
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (stationResult.error) throw new Error(stationResult.error.message);
  const existingMetadata = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
  const manuallyClassified = existingMetadata.mapping_source === "manual_super_admin";
  const mappedEmployee = existing?.source_type === "employee" && Boolean(existing.source_record_id);
  const mappedLocation = existing?.source_type === "location" && Boolean(existing.source_record_id);
  const mappedStandalone = manuallyClassified && !existing?.source_type && ["service", "unmatched"].includes(existing?.account_type ?? "");
  const accountType = mappedEmployee
    ? "person"
    : mappedLocation
      ? "location"
      : mappedStandalone
        ? existing!.account_type
        : profileResult.data?.id
          ? "person"
          : stationResult.data?.id
            ? "location"
            : existing?.account_type ?? "unmatched";
  const sourceType = mappedEmployee || mappedLocation
    ? existing!.source_type
    : mappedStandalone
      ? null
      : profileResult.data?.id
        ? "profile"
        : stationResult.data?.id
          ? "location"
          : existing?.source_type ?? null;
  const sourceRecordId = mappedEmployee || mappedLocation
    ? existing!.source_record_id
    : mappedStandalone
      ? null
      : profileResult.data?.id ?? stationResult.data?.id ?? existing?.source_record_id ?? null;
  const result = await db().from("google_workspace_accounts").upsert({
    company_id: companyId,
    google_user_id: user.id,
    primary_email: email,
    full_name: user.name?.fullName || existing?.full_name || email.split("@")[0],
    org_unit_path: user.orgUnitPath || "/",
    account_type: accountType,
    account_state: user.suspended ? "suspended" : "active",
    profile_id: mappedLocation || mappedStandalone ? null : profileResult.data?.id ?? existing?.profile_id ?? null,
    location_id: mappedLocation
      ? existing?.location_id ?? existing?.source_record_id ?? null
      : mappedEmployee
        ? existing?.location_id ?? null
        : mappedStandalone
          ? null
          : stationResult.data?.id ?? existing?.location_id ?? null,
    source_type: sourceType,
    source_record_id: sourceRecordId,
    person_id: existing?.person_id ?? null,
    designation_id: existing?.designation_id ?? null,
    group_emails: existing?.group_emails ?? [],
    is_google_admin: Boolean(user.isAdmin),
    suspended: Boolean(user.suspended),
    archived: Boolean(user.archived),
    last_seen_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    last_error: null,
    google_etag: user.etag ?? null,
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,primary_email" }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  const accountId = result.data.id as string;

  if (user.suspended) {
    const eligibleAt = existing?.deletion_eligible_at ?? new Date(Date.now() + retentionDays * 86400000).toISOString();
    const accountUpdate = await db().from("google_workspace_accounts")
      .update({ deletion_eligible_at: eligibleAt, updated_at: new Date().toISOString() })
      .eq("id", accountId).is("deletion_eligible_at", null);
    if (accountUpdate.error) throw new Error(accountUpdate.error.message);

    if (profileResult.data?.id) {
      const revoke = await db().rpc("revoke_dropx_workspace_access", {
        p_company_id: companyId,
        p_profile_id: profileResult.data.id,
        p_person_id: existing?.person_id ?? null,
        p_reason: "google_directory_suspended"
      });
      if (revoke.error) throw new Error(revoke.error.message);
    }

    const deletion = await db().from("google_workspace_deletion_requests").upsert({
      company_id: companyId,
      account_id: accountId,
      status: "retention",
      eligible_at: eligibleAt,
      data_transfer_status: "pending",
      note: "Created during Google directory reconciliation for an already suspended account."
    }, { onConflict: "company_id,account_id", ignoreDuplicates: true });
    if (deletion.error) throw new Error(deletion.error.message);
  }

  return accountId;
}

export async function syncWorkspaceDirectory(companyId: string, actorId?: string | null) {
  const setting = await loadSettings(companyId);
  if (!setting.directory_sync_enabled) throw new Error("Google Workspace directory sync is disabled.");
  const connection = clientFor(setting);
  await db().from("google_workspace_settings").update({ last_sync_status: "running", last_sync_error: null, updated_at: new Date().toISOString() }).eq("company_id", companyId);
  try {
    const [users, existingResult] = await Promise.all([
      connection.listUsers(),
      db().from("google_workspace_accounts").select("*").eq("company_id", companyId)
    ]);
    if (existingResult.error) throw new Error(existingResult.error.message);
    const existingByGoogleId = new Map((existingResult.data ?? []).map((row) => [row.google_user_id, row as WorkspaceAccountRow]));
    const existingByEmail = new Map((existingResult.data ?? []).map((row) => [normalizeEmail(row.primary_email), row as WorkspaceAccountRow]));
    for (const user of users) {
      await saveDirectoryUser(
        companyId,
        user,
        setting.default_retention_days,
        existingByGoogleId.get(user.id) ?? existingByEmail.get(normalizeEmail(user.primaryEmail)) ?? null
      );
    }
    const now = new Date().toISOString();
    await db().from("google_workspace_settings").update({ last_sync_status: "success", last_sync_at: now, last_sync_error: null, updated_at: now }).eq("company_id", companyId);
    await db().from("google_workspace_deletion_requests").update({ status: "eligible", updated_at: now })
      .eq("company_id", companyId).eq("status", "retention").lte("eligible_at", now).eq("legal_hold", false);
    await audit({ companyId, actorId, action: "directory_sync", status: "success", detail: { users: users.length } });
    return { users: users.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Workspace directory sync failed.";
    await db().from("google_workspace_settings").update({ last_sync_status: "failed", last_sync_error: message, updated_at: new Date().toISOString() }).eq("company_id", companyId);
    await audit({ companyId, actorId, action: "directory_sync", status: "failed", detail: { error: message } });
    throw error;
  }
}

async function provisionEmployee(job: WorkspaceJobRow) {
  if (!job.source_record_id) throw new Error("The provisioning job has no employee reference.");
  const setting = await loadSettings(job.company_id, true);
  const source = await employeeSource(job.company_id, job.source_record_id);
  if (!source.active) throw new Error("The employee is inactive; provisioning was stopped.");
  const policy = await getPolicy(job.company_id, source.designationId);
  if (!policy?.issue_workspace_account) throw new Error("The employee designation does not have an active Workspace issuance policy.");
  if (policy.approval_mode === "manual" && !job.payload.approved) throw new Error("Manual approval is required before provisioning.");

  const connection = clientFor(setting);
  let account = job.account_id ? await getAccount(job.account_id) : null;
  let temporary: string | null = null;
  let googleUser: GoogleDirectoryUser | null = null;
  if (account?.google_user_id) googleUser = await connection.getUser(account.google_user_id);
  if (!googleUser) {
    const localPart = emailLocalPart(policy.email_pattern, source);
    const primaryEmail = account?.primary_email || await availableEmail(connection, setting.primary_domain, localPart, source.employeeCode);
    if (!account) {
      const existingAccount = await db().from("google_workspace_accounts").select("*")
        .eq("company_id", source.companyId).eq("source_type", "employee").eq("source_record_id", source.id).maybeSingle();
      if (existingAccount.error) throw new Error(existingAccount.error.message);
      if (existingAccount.data) {
        account = existingAccount.data as WorkspaceAccountRow;
      } else {
        const accountCreate = await db().from("google_workspace_accounts").insert({
        company_id: source.companyId,
        primary_email: primaryEmail,
        full_name: source.fullName,
        org_unit_path: policy.org_unit_path || setting.default_org_unit_path,
        account_type: "person",
        account_state: "provisioning",
        source_type: "employee",
        source_record_id: source.id,
        person_id: source.personId,
        designation_id: source.designationId,
        location_id: source.locationId,
          group_emails: []
        }).select("*").single();
        if (accountCreate.error) throw new Error(accountCreate.error.message);
        account = accountCreate.data as WorkspaceAccountRow;
      }
      await db().from("google_workspace_jobs").update({ account_id: account.id, updated_at: new Date().toISOString() }).eq("id", job.id);
    }
    temporary = temporaryPassword();
    const names = splitName(source.fullName);
    googleUser = await connection.createUser({
      primaryEmail,
      givenName: names.givenName,
      familyName: names.familyName,
      password: temporary,
      orgUnitPath: policy.org_unit_path || setting.default_org_unit_path
    });
    const saved = await db().from("google_workspace_accounts").update({
      google_user_id: googleUser.id,
      primary_email: normalizeEmail(googleUser.primaryEmail),
      full_name: googleUser.name?.fullName || source.fullName,
      org_unit_path: googleUser.orgUnitPath || policy.org_unit_path || setting.default_org_unit_path,
      account_state: "active",
      suspended: false,
      archived: false,
      last_seen_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      google_etag: googleUser.etag ?? null,
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq("id", account.id).select("*").single();
    if (saved.error) throw new Error(saved.error.message);
    account = saved.data as WorkspaceAccountRow;
  }
  if (!account) throw new Error("Workspace account mapping could not be created.");

  await syncManagedGroups(connection, account, policy.group_emails);
  const accessAccount = { ...account, group_emails: asStringArray(policy.group_emails) };
  await ensureDropxAccess({ account: accessAccount, source, policy });
  await db().from("google_workspace_accounts").update({
    account_state: "active",
    suspended: false,
    group_emails: policy.group_emails,
    designation_id: source.designationId,
    location_id: source.locationId,
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq("id", account.id);

  if (temporary && policy.send_activation_email && source.personalEmail && source.personalEmail !== account.primary_email) {
    try {
      await sendEmail({
        companyId: source.companyId,
        to: [source.personalEmail],
        subject: "Your DropX Google Workspace account",
        body: `Your official DropX account is ready.\n\nEmail: ${account.primary_email}\nTemporary password: ${temporary}\n\nGoogle will ask you to change this password at first sign-in. Do not share it.`
      });
    } catch (error) {
      await audit({ companyId: source.companyId, accountId: account.id, jobId: job.id, action: "activation_email", status: "failed", detail: { error: error instanceof Error ? error.message : "Email failed" } });
    }
  }
  return account.id;
}

async function updateEmployeeAccess(job: WorkspaceJobRow) {
  if (!job.account_id || !job.source_record_id) throw new Error("The access update job is incomplete.");
  const setting = await loadSettings(job.company_id, true);
  const source = await employeeSource(job.company_id, job.source_record_id);
  const policy = await getPolicy(job.company_id, source.designationId);
  if (!policy) throw new Error("The current designation has no active Workspace policy.");
  const account = await getAccount(job.account_id);
  const connection = clientFor(setting);
  if (account.google_user_id) {
    const names = splitName(source.fullName);
    await connection.patchUser(account.google_user_id, {
      name: { givenName: names.givenName, familyName: names.familyName },
      orgUnitPath: policy.org_unit_path
    });
  }
  await syncManagedGroups(connection, account, policy.group_emails);
  await ensureDropxAccess({ account: { ...account, group_emails: policy.group_emails }, source, policy });
  await db().from("google_workspace_accounts").update({
    full_name: source.fullName,
    org_unit_path: policy.org_unit_path,
    designation_id: source.designationId,
    location_id: source.locationId,
    group_emails: policy.group_emails,
    account_state: "active",
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq("id", account.id);
  return account.id;
}

async function revokeDropxAccess(account: WorkspaceAccountRow) {
  if (!account.profile_id) return;
  const now = new Date().toISOString();
  const profile = await db().from("profiles").update({ is_active: false, updated_at: now }).eq("company_id", account.company_id).eq("id", account.profile_id);
  if (profile.error) throw new Error(profile.error.message);
  const membership = await db().from("company_product_memberships").update({ is_active: false, updated_at: now })
    .eq("company_id", account.company_id).eq("user_id", account.profile_id);
  if (membership.error && !isMissingRelationError(membership.error)) throw new Error(membership.error.message);
  const peopleAccess = await db().from("hr_user_access").update({ is_active: false, updated_at: now })
    .eq("company_id", account.company_id).eq("user_id", account.profile_id);
  if (peopleAccess.error && !isMissingRelationError(peopleAccess.error)) throw new Error(peopleAccess.error.message);
  const grants = await db().from("hr_access_grants").update({ is_active: false, updated_at: now })
    .eq("company_id", account.company_id).eq("user_id", account.profile_id);
  if (grants.error && !isMissingRelationError(grants.error)) throw new Error(grants.error.message);
  const link = await db().from("hr_user_person_links").update({ status: "inactive", updated_at: now })
    .eq("company_id", account.company_id).eq("user_id", account.profile_id);
  if (link.error && !isMissingRelationError(link.error)) throw new Error(link.error.message);
}

async function suspendAccount(job: WorkspaceJobRow) {
  if (!job.account_id) throw new Error("The suspension job has no Workspace account.");
  const setting = await loadSettings(job.company_id);
  const account = await getAccount(job.account_id);
  await revokeDropxAccess(account);
  if (setting.automatic_suspension_enabled && account.google_user_id) {
    const connection = clientFor(setting);
    await connection.suspendUser(account.google_user_id);
    for (const group of account.group_emails ?? []) await connection.removeGroupMember(group, account.google_user_id);
  }
  const eligibleAt = account.deletion_eligible_at ??
    new Date(Date.now() + setting.default_retention_days * 86400000).toISOString();
  await db().from("google_workspace_accounts").update({
    account_state: "suspended",
    suspended: true,
    group_emails: [],
    deletion_eligible_at: eligibleAt,
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq("id", account.id);
  return account.id;
}

async function restoreAccount(job: WorkspaceJobRow) {
  if (!job.account_id || !job.source_record_id) throw new Error("The restoration job is incomplete.");
  const setting = await loadSettings(job.company_id, true);
  const account = await getAccount(job.account_id);
  if (account.google_user_id) await clientFor(setting).restoreUser(account.google_user_id);
  const source = await workerSource(job.company_id, job.source_record_id, job.source_type);
  const policy = await getPolicy(job.company_id, source.designationId);
  if (!policy) throw new Error("The current designation has no active Workspace policy.");
  await ensureDropxAccess({ account: { ...account, suspended: false }, source, policy });
  await syncManagedGroups(clientFor(setting), account, policy.group_emails);
  await db().from("google_workspace_accounts").update({ account_state: "active", suspended: false, group_emails: policy.group_emails, deletion_eligible_at: null, last_error: null, updated_at: new Date().toISOString() }).eq("id", account.id);
  await db().from("google_workspace_deletion_requests").update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("company_id", account.company_id).eq("account_id", account.id).neq("status", "completed");
  return account.id;
}

async function deleteAccount(job: WorkspaceJobRow) {
  if (!job.account_id) throw new Error("The deletion job has no Workspace account.");
  const setting = await loadSettings(job.company_id);
  const account = await getAccount(job.account_id);
  const deletion = await db().from("google_workspace_deletion_requests").select("*").eq("company_id", job.company_id).eq("account_id", account.id).maybeSingle();
  if (deletion.error || !deletion.data) throw new Error(deletion.error?.message ?? "Deletion approval was not found.");
  if (deletion.data.status !== "approved") throw new Error("The Workspace deletion has not been approved.");
  if (deletion.data.legal_hold) throw new Error("The Workspace account is under legal hold.");
  if (new Date(deletion.data.eligible_at).getTime() > Date.now()) throw new Error("The Workspace retention period has not ended.");
  if (!["completed", "not_required"].includes(deletion.data.data_transfer_status)) throw new Error("Complete or waive the data transfer before deletion.");
  if (account.google_user_id) await clientFor(setting).deleteUser(account.google_user_id);
  const now = new Date().toISOString();
  await db().from("google_workspace_accounts").update({ account_state: "deleted", suspended: true, last_error: null, updated_at: now }).eq("id", account.id);
  await db().from("google_workspace_deletion_requests").update({ status: "completed", completed_at: now, updated_at: now }).eq("id", deletion.data.id);
  return account.id;
}

async function runJob(job: WorkspaceJobRow) {
  if (job.job_type === "directory_sync") {
    await syncWorkspaceDirectory(job.company_id, job.requested_by);
    return job.account_id;
  }
  if (job.job_type === "provision") return provisionEmployee(job);
  if (job.job_type === "update_access") return updateEmployeeAccess(job);
  if (job.job_type === "suspend") return suspendAccount(job);
  if (job.job_type === "restore") return restoreAccount(job);
  if (job.job_type === "delete") return deleteAccount(job);
  throw new Error(`Unsupported Google Workspace job type: ${job.job_type}`);
}

function retryAt(attempt: number) {
  const minutes = Math.min(360, 2 ** Math.min(attempt, 8));
  return new Date(Date.now() + minutes * 60000).toISOString();
}

export async function processWorkspaceJobs(limit = 10, companyId?: string) {
  const now = new Date().toISOString();
  let query = db().from("google_workspace_jobs").select("*")
    .in("status", ["queued", "failed"]).lte("next_attempt_at", now)
    .order("priority", { ascending: true }).order("created_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 50)));
  if (companyId) query = query.eq("company_id", companyId);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  const jobs = (result.data ?? []) as WorkspaceJobRow[];
  const summary = { processed: 0, completed: 0, failed: 0, blocked: 0 };
  for (const job of jobs) {
    const claimed = await db().from("google_workspace_jobs").update({ status: "running", locked_at: now, attempt_count: job.attempt_count + 1, updated_at: now })
      .eq("id", job.id).in("status", ["queued", "failed"]).select("id").maybeSingle();
    if (claimed.error || !claimed.data) continue;
    summary.processed += 1;
    try {
      const accountId = await runJob({ ...job, attempt_count: job.attempt_count + 1 });
      const completedAt = new Date().toISOString();
      await db().from("google_workspace_jobs").update({ status: "completed", account_id: accountId ?? job.account_id, completed_at: completedAt, locked_at: null, last_error: null, updated_at: completedAt }).eq("id", job.id);
      await audit({ companyId: job.company_id, accountId: accountId ?? job.account_id, jobId: job.id, actorId: job.requested_by, action: job.job_type, status: "success" });
      summary.completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Workspace job failed.";
      const attempts = job.attempt_count + 1;
      const shouldBlock = attempts >= job.max_attempts || message.includes("approval is required") || message.includes("has no active Workspace policy") || message.includes("inactive; provisioning was stopped");
      await db().from("google_workspace_jobs").update({
        status: shouldBlock ? "blocked" : "failed",
        locked_at: null,
        last_error: message,
        next_attempt_at: shouldBlock ? now : retryAt(attempts),
        updated_at: new Date().toISOString()
      }).eq("id", job.id);
      if (job.account_id) await db().from("google_workspace_accounts").update({ account_state: "error", last_error: message, updated_at: new Date().toISOString() }).eq("id", job.account_id);
      await audit({ companyId: job.company_id, accountId: job.account_id, jobId: job.id, actorId: job.requested_by, action: job.job_type, status: shouldBlock ? "blocked" : "failed", detail: { error: message, attempt: attempts } });
      if (shouldBlock) summary.blocked += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}

export async function queueWorkspaceJob(input: {
  companyId: string;
  jobType: WorkspaceJobRow["job_type"];
  actorId: string;
  accountId?: string | null;
  sourceType?: string | null;
  sourceRecordId?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
}) {
  const idempotency = `${input.jobType}:${input.accountId ?? input.sourceRecordId ?? input.companyId}:${Date.now()}:${randomBytes(3).toString("hex")}`;
  const result = await db().from("google_workspace_jobs").insert({
    company_id: input.companyId,
    account_id: input.accountId ?? null,
    job_type: input.jobType,
    status: "queued",
    priority: input.priority ?? 50,
    idempotency_key: idempotency,
    source_type: input.sourceType ?? null,
    source_record_id: input.sourceRecordId ?? null,
    payload: input.payload ?? {},
    requested_by: input.actorId,
    approved_by: input.payload?.approved ? input.actorId : null
  }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  await audit({ companyId: input.companyId, accountId: input.accountId, jobId: result.data.id, actorId: input.actorId, action: input.jobType, status: "requested" });
  return result.data.id as string;
}
