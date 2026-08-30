"use server";

import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { processWorkspaceJobs, queueWorkspaceJob, syncWorkspaceDirectory } from "@/lib/google-workspace-service";
import { isProductCode } from "@/lib/product-ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";

const pagePath = "/settings/google-workspace";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function required(value: FormDataEntryValue | null, label: string) {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function checked(formData: FormData, name: string) {
  return formData.get(name) === "true" || formData.get(name) === "on";
}

function positiveInteger(value: FormDataEntryValue | null, label: string, minimum = 0, maximum = 3650) {
  const parsed = Number.parseInt(clean(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function emails(value: FormDataEntryValue | null) {
  const rows = clean(value).split(/[\n,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const email of rows) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid group email: ${email}`);
  }
  return Array.from(new Set(rows));
}

function isNextRedirect(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

function flash(params: { error?: string; notice?: string }, suffix = ""): never {
  cookies().set("dropx_google_workspace_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 45,
    path: pagePath,
    sameSite: "lax"
  });
  redirect(`${pagePath}${suffix}`);
}

function friendly(error: unknown) {
  const message = error instanceof Error ? error.message : "Google Workspace action failed.";
  if (message.includes("google_workspace_") && (message.includes("does not exist") || message.includes("schema cache"))) {
    return "The Google Workspace database migration has not been applied yet.";
  }
  return message;
}

function database() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

export async function saveWorkspaceSettings(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const primaryDomain = required(formData.get("primary_domain"), "Primary domain").toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(primaryDomain)) throw new Error("Enter a valid Google Workspace domain.");
    const delegatedAdmin = required(formData.get("delegated_admin_email"), "Delegated administrator").toLowerCase();
    if (!delegatedAdmin.endsWith(`@${primaryDomain}`)) throw new Error("The delegated administrator must use the primary Workspace domain.");
    const orgUnit = required(formData.get("default_org_unit_path"), "Default organisational unit");
    if (!orgUnit.startsWith("/")) throw new Error("The organisational unit path must start with /. ");

    const result = await database().from("google_workspace_settings").upsert({
      company_id: companyId,
      customer_id: clean(formData.get("customer_id")) || null,
      primary_domain: primaryDomain,
      delegated_admin_email: delegatedAdmin,
      default_org_unit_path: orgUnit,
      directory_sync_enabled: checked(formData, "directory_sync_enabled"),
      provisioning_enabled: checked(formData, "provisioning_enabled"),
      automatic_suspension_enabled: checked(formData, "automatic_suspension_enabled"),
      default_retention_days: positiveInteger(formData.get("default_retention_days"), "Retention days", 1, 3650),
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id" });
    if (result.error) throw new Error(result.error.message);
    revalidatePath(pagePath);
    flash({ notice: "Google Workspace connection master saved." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function saveDesignationWorkspacePolicy(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  let designationId = "";
  try {
    designationId = required(formData.get("designation_id"), "Designation");
    const issueAccount = checked(formData, "issue_workspace_account");
    const approvalMode = clean(formData.get("approval_mode"));
    if (!["automatic", "manual"].includes(approvalMode)) throw new Error("Select a valid approval mode.");
    const locationMode = clean(formData.get("location_access_mode"));
    if (!["assignment", "all_locations", "none"].includes(locationMode)) throw new Error("Select a valid location access mode.");
    const productCodes = Array.from(new Set(formData.getAll("product_codes").map(String).filter(isProductCode)));
    const accessRoleId = clean(formData.get("access_role_id")) || null;
    const orgUnit = required(formData.get("org_unit_path"), "Organisational unit");
    if (!orgUnit.startsWith("/")) throw new Error("The organisational unit path must start with /. ");
    const emailPattern = required(formData.get("email_pattern"), "Email pattern").toLowerCase();
    const allowedTokens = ["{first}", "{last}", "{employee_code}", "{designation_code}", "{location_code}"];
    const withoutTokens = allowedTokens.reduce((value, token) => value.replaceAll(token, ""), emailPattern);
    if (/[^a-z0-9._-]/.test(withoutTokens)) throw new Error("The email pattern contains an unsupported token or character.");
    if (!allowedTokens.some((token) => emailPattern.includes(token))) throw new Error("Use at least one supported token in the email pattern.");

    const designation = await database().from("designations").select("id").eq("company_id", companyId).eq("id", designationId).maybeSingle();
    if (designation.error || !designation.data) throw new Error(designation.error?.message ?? "Designation is unavailable.");
    if (accessRoleId) {
      const role = await database().from("user_roles").select("id").eq("company_id", companyId).eq("id", accessRoleId).eq("is_active", true).maybeSingle();
      if (role.error || !role.data) throw new Error(role.error?.message ?? "Selected access role is unavailable.");
    }

    const saved = await database().from("google_workspace_designation_policies").upsert({
      company_id: companyId,
      designation_id: designationId,
      issue_workspace_account: issueAccount,
      approval_mode: approvalMode,
      email_pattern: emailPattern,
      org_unit_path: orgUnit,
      group_emails: emails(formData.get("group_emails")),
      access_role_id: accessRoleId,
      product_codes: productCodes,
      location_access_mode: locationMode,
      send_activation_email: checked(formData, "send_activation_email"),
      retention_days: clean(formData.get("retention_days"))
        ? positiveInteger(formData.get("retention_days"), "Retention days", 1, 3650)
        : null,
      is_active: checked(formData, "is_active"),
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,designation_id" }).select("id").single();
    if (saved.error) throw new Error(saved.error.message);

    if (issueAccount && checked(formData, "is_active")) {
      const [employees, accounts] = await Promise.all([
        database().from("employees").select("id").eq("company_id", companyId).eq("designation_id", designationId).eq("is_active", true),
        database().from("google_workspace_accounts").select("id,source_record_id,google_user_id,suspended")
          .eq("company_id", companyId).eq("source_type", "employee").eq("designation_id", designationId)
      ]);
      if (employees.error) throw new Error(employees.error.message);
      if (accounts.error) throw new Error(accounts.error.message);
      const accountByEmployee = new Map((accounts.data ?? []).map((account) => [account.source_record_id, account]));
      const now = new Date().toISOString();
      const jobs = (employees.data ?? []).map((employee) => {
        const account = accountByEmployee.get(employee.id);
        const jobType = account?.suspended ? "restore" : account?.google_user_id ? "update_access" : "provision";
        return {
          company_id: companyId,
          account_id: account?.id ?? null,
          job_type: jobType,
          status: approvalMode === "automatic" ? "queued" : "blocked",
          priority: 50,
          idempotency_key: `${jobType}:employee:${employee.id}:policy:${saved.data.id}:${randomUUID()}`,
          source_type: "employee",
          source_record_id: employee.id,
          payload: { policy_id: saved.data.id, reason: "designation_policy_saved" },
          requested_by: authorization.userId,
          next_attempt_at: now
        };
      });
      if (jobs.length) {
        const queued = await database().from("google_workspace_jobs").insert(jobs);
        if (queued.error) throw new Error(queued.error.message);
      }
    }

    revalidatePath(pagePath);
    flash({ notice: "Designation Workspace policy saved and eligible active profiles queued." }, `?designation=${designationId}`);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) }, designationId ? `?designation=${designationId}` : "");
  }
}

export async function syncWorkspaceNow() {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const result = await syncWorkspaceDirectory(companyId, authorization.userId);
    revalidatePath(pagePath);
    flash({ notice: `${result.users} Google Workspace accounts synced.` });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function processWorkspaceQueueNow() {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const result = await processWorkspaceJobs(25, companyId);
    revalidatePath(pagePath);
    flash({ notice: `Queue processed: ${result.completed} completed, ${result.failed} retrying, ${result.blocked} blocked.` });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function approveWorkspaceJob(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const jobId = required(formData.get("job_id"), "Job");
    const current = await database().from("google_workspace_jobs").select("id,payload,status").eq("company_id", companyId).eq("id", jobId).maybeSingle();
    if (current.error || !current.data) throw new Error(current.error?.message ?? "Workspace job was not found.");
    const result = await database().from("google_workspace_jobs").update({
      status: "queued",
      payload: { ...(current.data.payload ?? {}), approved: true },
      approved_by: authorization.userId,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", jobId);
    if (result.error) throw new Error(result.error.message);
    revalidatePath(pagePath);
    flash({ notice: "Workspace job approved and queued." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function retryWorkspaceJob(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const jobId = required(formData.get("job_id"), "Job");
    const result = await database().from("google_workspace_jobs").update({
      status: "queued", last_error: null, next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", jobId).in("status", ["failed", "blocked"]);
    if (result.error) throw new Error(result.error.message);
    revalidatePath(pagePath);
    flash({ notice: "Workspace job queued for retry." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function updateWorkspaceDeletionReview(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const deletionId = required(formData.get("deletion_id"), "Deletion request");
    const transferStatus = clean(formData.get("data_transfer_status"));
    if (!["pending", "in_progress", "completed", "not_required"].includes(transferStatus)) throw new Error("Select a valid data transfer status.");
    const result = await database().from("google_workspace_deletion_requests").update({
      data_transfer_status: transferStatus,
      legal_hold: checked(formData, "legal_hold"),
      note: clean(formData.get("note")) || null,
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", deletionId);
    if (result.error) throw new Error(result.error.message);
    revalidatePath(pagePath);
    flash({ notice: "Deletion safeguards updated." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function approveWorkspaceDeletion(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const deletionId = required(formData.get("deletion_id"), "Deletion request");
    const deletion = await database().from("google_workspace_deletion_requests").select("*,google_workspace_accounts(id)")
      .eq("company_id", companyId).eq("id", deletionId).maybeSingle();
    if (deletion.error || !deletion.data) throw new Error(deletion.error?.message ?? "Deletion request was not found.");
    if (deletion.data.legal_hold) throw new Error("Remove the legal hold before approving deletion.");
    if (new Date(deletion.data.eligible_at).getTime() > Date.now()) throw new Error("The retention period has not ended.");
    if (!["completed", "not_required"].includes(deletion.data.data_transfer_status)) throw new Error("Complete or waive data transfer before approving deletion.");
    const approved = await database().from("google_workspace_deletion_requests").update({
      status: "approved", approved_by: authorization.userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", deletionId);
    if (approved.error) throw new Error(approved.error.message);
    await queueWorkspaceJob({ companyId, jobType: "delete", actorId: authorization.userId, accountId: deletion.data.account_id, payload: { deletion_id: deletionId, approved: true }, priority: 90 });
    revalidatePath(pagePath);
    flash({ notice: "Deletion approved. The protected worker will execute it from the queue." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}

export async function cancelWorkspaceDeletion(formData: FormData) {
  const authorization = await requirePagePermission("workspace_identity", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const deletionId = required(formData.get("deletion_id"), "Deletion request");
    const result = await database().from("google_workspace_deletion_requests").update({
      status: "cancelled", cancelled_by: authorization.userId, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", deletionId).neq("status", "completed");
    if (result.error) throw new Error(result.error.message);
    revalidatePath(pagePath);
    flash({ notice: "Deletion request cancelled. The suspended account was not restored." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    flash({ error: friendly(error) });
  }
}
