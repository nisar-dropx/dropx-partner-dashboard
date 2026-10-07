"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const DEVICES_PATH = "/settings/dropx-one-devices";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function returnPath(formData: FormData) {
  const raw = clean(formData.get("return_to"));
  return raw.startsWith(DEVICES_PATH) ? raw : DEVICES_PATH;
}

function withNotice(path: string, key: "notice" | "error", message: string) {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("notice");
  params.delete("error");
  params.set(key, message);
  return `${base}?${params.toString()}`;
}

/**
 * Clears a person's bound phone so they can sign in to DropX One on a new one. Also signs out
 * every DropX One app session on their mobile number, so the old phone stops working immediately
 * instead of staying logged in on its existing session. Same behaviour as the People (HRMS)
 * device reset; this one is for workforce and delivery staff who are managed from the dashboard.
 */
export async function resetDropxOneDevice(formData: FormData) {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const next = returnPath(formData);
  if (authorization.readOnly || !authorization.permissions.app_settings?.canEdit) {
    redirect(withNotice(next, "error", "You do not have access to reset devices."));
  }
  if (!supabaseAdmin) redirect(withNotice(next, "error", "Supabase service role key is not configured."));

  const bindingId = clean(formData.get("binding_id"));
  const reason = clean(formData.get("reason")).slice(0, 300);
  if (!bindingId) redirect(withNotice(next, "error", "Choose a device to reset."));

  const binding = await supabaseAdmin
    .from("connect_account_devices")
    .select("id, display_name, country_code, mobile_number")
    .eq("company_id", companyId)
    .eq("id", bindingId)
    .is("reset_at", null)
    .maybeSingle();
  if (binding.error) redirect(withNotice(next, "error", binding.error.message));
  if (!binding.data) redirect(withNotice(next, "error", "That device was already reset."));

  const { country_code: countryCode, mobile_number: mobile, display_name: name } = binding.data;
  const now = new Date().toISOString();
  // One mobile number can have several DropX One accounts (e.g. employee + workforce), each with
  // its own binding row; login is blocked if ANY of them points at another phone, so all of this
  // person's bindings in the company are cleared together.
  let reset = supabaseAdmin
    .from("connect_account_devices")
    .update({ reset_at: now, reset_by: authorization.userId, reset_reason: reason || null, updated_at: now })
    .eq("company_id", companyId)
    .is("reset_at", null);
  reset = countryCode && mobile
    ? reset.eq("country_code", countryCode).eq("mobile_number", mobile)
    : reset.eq("id", bindingId);
  const resetResult = await reset;
  if (resetResult.error) redirect(withNotice(next, "error", resetResult.error.message));

  if (countryCode && mobile) {
    const revoke = await supabaseAdmin
      .from("connect_login_sessions")
      .update({ revoked_at: now })
      .eq("country_code", countryCode)
      .eq("mobile_number", mobile)
      .is("revoked_at", null)
      .ilike("user_agent", "%DropXOneNative%");
    if (revoke.error) {
      redirect(withNotice(next, "error", `Device reset for ${name || "this person"}, but their old phone could not be signed out: ${revoke.error.message}`));
    }
  }

  revalidatePath(DEVICES_PATH);
  redirect(withNotice(next, "notice", `Device reset for ${name || "this person"}. They can now sign in on a new phone.`));
}
