import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function cleanMobile(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}

function temporaryPassword() {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

function connectOnlyEmail(input: { companyId: string; personId: string; mobile: string; employeeCode?: string | null }) {
  const local = input.mobile.replace(/^91/, "");
  const token = (input.employeeCode || local || input.personId.replace(/-/g, "").slice(0, 12)).toLowerCase().replace(/[^a-z0-9._-]+/g, ".");
  return `${token}.${input.companyId.slice(0, 8)}@one.connect.dropxlogistics.internal`;
}

async function ensurePersonLink(companyId: string, personId: string, userId: string) {
  const existing = await db().from("hr_user_person_links").select("id,status")
    .eq("company_id", companyId).eq("person_id", personId).maybeSingle();
  if (existing.error && !/does not exist|schema cache/i.test(existing.error.message)) {
    throw new Error(existing.error.message);
  }
  const payload = {
    company_id: companyId,
    user_id: userId,
    person_id: personId,
    status: "active",
    updated_at: new Date().toISOString()
  };
  if (existing.data?.id) {
    const save = await db().from("hr_user_person_links").update(payload).eq("id", existing.data.id);
    if (save.error) throw new Error(save.error.message);
    return;
  }
  const save = await db().from("hr_user_person_links").insert(payload);
  if (save.error) throw new Error(save.error.message);
}

async function workforceContactForPerson(companyId: string, personId: string) {
  const engagement = await db().from("hr_engagements").select("worker_type,employee_id,contractor_id,status")
    .eq("company_id", companyId).eq("person_id", personId).eq("status", "active")
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return null;

  if (engagement.data.worker_type === "employee" && engagement.data.employee_id) {
    const employee = await db().from("employees").select("full_name,email,mobile,mobile_country_code,employee_code,is_active")
      .eq("company_id", companyId).eq("id", engagement.data.employee_id).maybeSingle();
    if (employee.error) throw new Error(employee.error.message);
    if (!employee.data?.is_active) return null;
    return {
      fullName: String(employee.data.full_name ?? "").trim(),
      email: String(employee.data.email ?? "").trim().toLowerCase() || null,
      mobile: cleanMobile(employee.data.mobile),
      countryCode: cleanMobile(employee.data.mobile_country_code) || "91",
      employeeCode: String(employee.data.employee_code ?? "").trim() || null
    };
  }

  if (engagement.data.worker_type === "contractor" && engagement.data.contractor_id) {
    const contractor = await db().from("contractors").select("full_name,email,mobile,mobile_country_code,dropx_id,is_active")
      .eq("company_id", companyId).eq("id", engagement.data.contractor_id).maybeSingle();
    if (contractor.error) throw new Error(contractor.error.message);
    if (!contractor.data?.is_active) return null;
    return {
      fullName: String(contractor.data.full_name ?? "").trim(),
      email: String(contractor.data.email ?? "").trim().toLowerCase() || null,
      mobile: cleanMobile(contractor.data.mobile),
      countryCode: cleanMobile(contractor.data.mobile_country_code) || "91",
      employeeCode: String(contractor.data.dropx_id ?? "").trim() || null
    };
  }

  return null;
}

async function findProfileByMobile(companyId: string, mobile: string, countryCode: string) {
  const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  const profile = await db().from("profiles").select("id")
    .eq("company_id", companyId).eq("is_active", true)
    .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`).limit(1).maybeSingle();
  if (profile.error) throw new Error(profile.error.message);
  return profile.data?.id ?? null;
}

/**
 * Resolves the portal user id used as approver_user_id for DropX One manager approvals.
 * Store / station managers without Google Workspace still receive approvals in One when
 * they have an active workforce record with a mobile number.
 */
export async function resolveConnectApproverUserId(companyId: string, personId: string): Promise<string | null> {
  const link = await db().from("hr_user_person_links").select("user_id,status")
    .eq("company_id", companyId).eq("person_id", personId).maybeSingle();
  if (link.error && !/does not exist|schema cache/i.test(link.error.message)) {
    throw new Error(link.error.message);
  }
  if (link.data?.status === "active" && link.data.user_id) return link.data.user_id;

  const contact = await workforceContactForPerson(companyId, personId);
  if (!contact?.mobile) return null;

  const existingProfileId = await findProfileByMobile(companyId, contact.mobile, contact.countryCode);
  if (existingProfileId) {
    await ensurePersonLink(companyId, personId, existingProfileId);
    return existingProfileId;
  }

  const email = contact.email || connectOnlyEmail({
    companyId,
    personId,
    mobile: contact.mobile,
    employeeCode: contact.employeeCode
  });

  let userId: string | null = null;
  const existingAuth = await db().from("profiles").select("id")
    .eq("company_id", companyId).ilike("email", email).eq("is_active", true).limit(1).maybeSingle();
  if (existingAuth.error) throw new Error(existingAuth.error.message);
  userId = existingAuth.data?.id ?? null;

  if (!userId) {
    const created = await db().auth.admin.createUser({
      email,
      email_confirm: true,
      password: temporaryPassword(),
      user_metadata: {
        full_name: contact.fullName || "DropX One manager",
        provisioned_by: "dropx_one_manager"
      }
    });
    if (created.error || !created.data.user) {
      if (!/already|exists|registered/i.test(created.error?.message ?? "")) {
        throw new Error(created.error?.message ?? "DropX One manager login could not be created.");
      }
      const listed = await db().auth.admin.listUsers({ page: 1, perPage: 200 });
      userId = listed.data.users.find((user) => user.email?.toLowerCase() === email)?.id ?? null;
      if (!userId) return null;
    } else {
      userId = created.data.user.id;
    }
  }

  const profileSave = await db().from("profiles").upsert({
    id: userId,
    company_id: companyId,
    full_name: contact.fullName || "DropX One manager",
    email,
    mobile_country_code: contact.countryCode,
    mobile: contact.mobile,
    employee_id: contact.employeeCode,
    invite_method: "DropX One",
    is_active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: "id" });
  if (profileSave.error) throw new Error(profileSave.error.message);

  await ensurePersonLink(companyId, personId, userId);
  return userId;
}

