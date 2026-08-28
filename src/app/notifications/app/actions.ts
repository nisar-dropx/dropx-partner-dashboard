"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { deliverNotificationPush } from "@/lib/firebase-push";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType, workforceTable, type WorkforceProfileType } from "@/lib/workforce-profiles";

const internalRoutes = new Set(["", "dashboard", "profile", "attendance", "leave", "settings"]);
const variablePattern = /\{(full_name|dropx_id|biometric_id|category|location|designation)\}/g;
const profileLabels: Record<WorkforceProfileType, string> = {
  employee: "Employee",
  workforce: "Workforce",
  field_executive: "Field executive",
  contractor: "Independent contractor",
  vendor: "Vendor",
  worker: "Worker"
};

type SelectedRecipient = { id: string; profileType: WorkforceProfileType };
type ResolvedRecipient = SelectedRecipient & {
  biometricId: string;
  category: string;
  designation: string;
  fullName: string;
  location: string;
  reference: string;
};

function fail(message: string): never {
  redirect(`/notifications/app?error=${encodeURIComponent(message)}`);
}

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function parseRecipients(value: FormDataEntryValue | null) {
  let keys: unknown;
  try {
    keys = JSON.parse(String(value ?? "[]"));
  } catch {
    fail("The recipient selection is invalid");
  }
  if (!Array.isArray(keys)) fail("Select at least one recipient");
  const unique = Array.from(new Set(keys.map((key) => String(key))));
  if (!unique.length) fail("Select at least one recipient");
  if (unique.length > 500) fail("Select no more than 500 recipients at a time");
  return unique.map((key) => {
    const separator = key.indexOf(":");
    const profileType = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (separator < 1 || !id || !isWorkforceProfileType(profileType)) {
      fail("One or more selected recipients are invalid");
    }
    return { id, profileType } as SelectedRecipient;
  });
}

function applyVariables(template: string, recipient: ResolvedRecipient) {
  const values: Record<string, string> = {
    full_name: recipient.fullName,
    dropx_id: recipient.reference,
    biometric_id: recipient.biometricId,
    category: recipient.category,
    location: recipient.location,
    designation: recipient.designation
  };
  return template.replace(variablePattern, (_, key: string) => values[key] ?? "");
}

function validatedExternalUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function resolveRecipients(companyId: string, selected: SelectedRecipient[]) {
  const resolved: ResolvedRecipient[] = [];
  for (const profileType of Array.from(new Set(selected.map((recipient) => recipient.profileType)))) {
    const ids = selected.filter((recipient) => recipient.profileType === profileType).map((recipient) => recipient.id);
    const referenceColumn = profileType === "employee" ? "employee_code" : "dropx_id";
    const designationColumn = profileType === "employee" ? "designation_id" : "designation";
    const result = await supabaseAdmin!
      .from(workforceTable(profileType))
      .select(`id, full_name, biometric_id, ${designationColumn}, ${referenceColumn}, stations (station_code)`)
      .eq("company_id", companyId)
      .in("id", ids);
    if (result.error) fail(result.error.message);
    const records = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    const employeeDesignationIds = profileType === "employee"
      ? Array.from(new Set(records.map((row) => row.designation_id).filter(Boolean)))
      : [];
    const designationResult = employeeDesignationIds.length
      ? await supabaseAdmin!.from("designations").select("id, name").in("id", employeeDesignationIds)
      : { data: [], error: null };
    if (designationResult.error) fail(designationResult.error.message);
    const designationById = new Map((designationResult.data ?? []).map((row) => [String(row.id), String(row.name ?? "")]));
    records.forEach((record) => {
      const station = first(record.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
      resolved.push({
        id: String(record.id),
        profileType,
        biometricId: String(record.biometric_id ?? ""),
        category: profileLabels[profileType],
        designation: profileType === "employee"
          ? designationById.get(String(record.designation_id ?? "")) ?? ""
          : String(record.designation ?? ""),
        fullName: String(record.full_name ?? ""),
        location: String(station?.station_code ?? ""),
        reference: String(record[referenceColumn] ?? "")
      });
    });
  }
  if (resolved.length !== selected.length) fail("One or more selected recipients are no longer available");
  return resolved;
}

export async function sendAppNotification(formData: FormData) {
  const authorization = await requirePagePermission("notifications_app", "add");
  if (!supabaseAdmin) fail("Supabase is not configured");
  if (!authorization.companyId) fail("Select a company before sending");

  const companyId = authorization.companyId;
  const selected = parseRecipients(formData.get("selectedRecipients"));
  const titleTemplate = String(formData.get("title") ?? "").trim();
  const bodyTemplate = String(formData.get("body") ?? "").trim();
  const openTarget = String(formData.get("openTarget") ?? "").trim();
  const customUrlTemplate = String(formData.get("customUrl") ?? "").trim();

  if (!titleTemplate || !bodyTemplate) fail("Title and message are required");
  if (titleTemplate.length > 120 || bodyTemplate.length > 1000) fail("Notification text is too long");
  if (openTarget === "custom_url" && !customUrlTemplate) fail("Enter a custom URL");
  if (openTarget !== "custom_url" && !internalRoutes.has(openTarget)) fail("The selected app page is invalid");

  const recipients = await resolveRecipients(companyId, selected);
  const batchId = randomUUID();
  const rows = recipients.map((recipient) => {
    const title = applyVariables(titleTemplate, recipient).trim();
    const body = applyVariables(bodyTemplate, recipient).trim();
    const personalizedUrl = openTarget === "custom_url" ? applyVariables(customUrlTemplate, recipient).trim() : "";
    const route = openTarget === "custom_url" ? validatedExternalUrl(personalizedUrl) : openTarget || null;
    if (!title || !body) fail(`The personalized notification for ${recipient.fullName} is empty`);
    if (title.length > 120 || body.length > 1000) fail(`The personalized notification for ${recipient.fullName} is too long`);
    if (openTarget === "custom_url" && !route) fail(`The custom URL for ${recipient.fullName} is invalid`);
    return {
      body,
      company_id: companyId,
      created_by: authorization.userId,
      data: { batchId },
      event_code: "manual",
      push_status: "not_configured",
      recipient_account_id: recipient.id,
      recipient_profile_type: recipient.profileType,
      route,
      title
    };
  });

  const result = await supabaseAdmin
    .from("mob_app_notifications")
    .insert(rows)
    .select("id, recipient_profile_type, recipient_account_id, title, body, route, data");
  if (result.error) {
    const message = result.error.message.toLowerCase().includes("mob_app_notifications")
      ? "Run scripts/mob_app_notifications_v1.sql in Supabase first"
      : result.error.message;
    fail(message);
  }

  const created = result.data ?? [];
  for (let index = 0; index < created.length; index += 25) {
    const batch = created.slice(index, index + 25);
    await Promise.allSettled(batch.map((notification) => deliverNotificationPush({
      id: notification.id,
      companyId,
      profileType: notification.recipient_profile_type,
      accountId: notification.recipient_account_id,
      title: notification.title,
      body: notification.body,
      route: notification.route,
      data: notification.data ?? {}
    })));
  }

  redirect(`/notifications/app?sent=${created.length}`);
}
