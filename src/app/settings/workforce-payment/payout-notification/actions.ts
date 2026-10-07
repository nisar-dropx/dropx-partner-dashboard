"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  extractWhatsAppTemplateVariables,
  getWhatsAppTemplateHeaderMediaType,
  type WhatsAppTemplateComponent
} from "@/lib/whatsapp-template";
import { syncWhatsAppTemplateCache } from "@/lib/whatsapp-template-sync";
import {
  WORKFORCE_PAYOUT_WHATSAPP_EVENT,
  WORKFORCE_PAYOUT_WHATSAPP_FIELDS
} from "@/lib/workforce-payout-whatsapp";

const PAGE_PATH = "/settings/workforce-payment/payout-notification";
const FLASH_COOKIE = "dropx_workforce_payout_whatsapp_flash";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function isRedirectError(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

function settingsRedirect(params: { error?: string; notice?: string }): never {
  cookies().set(FLASH_COOKIE, JSON.stringify(params), {
    httpOnly: true,
    maxAge: 30,
    path: PAGE_PATH,
    sameSite: "lax"
  });
  redirect(PAGE_PATH);
}

export async function saveWorkforcePayoutWhatsAppConfiguration(formData: FormData) {
  try {
    const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const isEnabled = formData.get("is_enabled") === "on";
    const profileId = clean(formData.get("whatsapp_profile_id")) || null;
    const templateId = clean(formData.get("template_id")) || null;
    let mappings: Record<string, string> = {};
    try {
      const parsed = JSON.parse(clean(formData.get("variable_mappings_json")) || "{}") as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      mappings = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, clean(String(value))]));
    } catch {
      throw new Error("Template variable mapping is invalid.");
    }

    if (isEnabled && (!profileId || !templateId)) {
      throw new Error("Select an active WhatsApp sender and approved template before enabling notifications.");
    }
    if (isEnabled) {
      const globalSettings = await supabaseAdmin
        .from("whatsapp_settings")
        .select("is_enabled")
        .eq("company_id", companyId)
        .eq("id", true)
        .maybeSingle();
      if (globalSettings.error || !globalSettings.data?.is_enabled) {
        throw new Error("Enable WhatsApp messaging in Meta settings before enabling payout notifications.");
      }
    }

    let templateName: string | null = null;
    let templateLanguage: string | null = null;
    if (profileId || templateId) {
      if (!profileId || !templateId) throw new Error("Select both the WhatsApp sender and its approved template.");
      const [profileResult, templateResult] = await Promise.all([
        supabaseAdmin
          .from("whatsapp_profiles")
          .select("id,is_active")
          .eq("company_id", companyId)
          .eq("id", profileId)
          .maybeSingle(),
        supabaseAdmin
          .from("whatsapp_template_cache")
          .select("template_id,whatsapp_profile_id,name,language,status,components")
          .eq("company_id", companyId)
          .eq("whatsapp_profile_id", profileId)
          .eq("template_id", templateId)
          .maybeSingle()
      ]);
      if (profileResult.error || !profileResult.data) throw new Error("Select a WhatsApp sender in your company.");
      if (isEnabled && !profileResult.data.is_active) throw new Error("Select an active WhatsApp sender in your company.");
      if (templateResult.error || !templateResult.data) throw new Error("The selected WhatsApp template is unavailable. Sync templates and choose it again.");
      if (templateResult.data.whatsapp_profile_id !== profileId) throw new Error("The selected template does not belong to the selected WhatsApp sender.");
      if (isEnabled && templateResult.data.status !== "APPROVED") throw new Error("Only an approved WhatsApp template can be selected.");
      const components = (templateResult.data.components ?? []) as WhatsAppTemplateComponent[];
      if (isEnabled && getWhatsAppTemplateHeaderMediaType(components)) throw new Error("Payout notifications currently support text-only WhatsApp templates.");
      const variables = extractWhatsAppTemplateVariables(components);
      const allowedFields = new Set<string>(WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => field.value));
      const variableKeys = new Set(variables.map((variable) => variable.key));
      if (Object.entries(mappings).some(([key, source]) => !variableKeys.has(key) || !allowedFields.has(source))) {
        throw new Error("Choose payout data only from the available variable list.");
      }
      const missing = variables.filter((variable) => !mappings[variable.key]);
      if (missing.length) throw new Error(`Map all template variables: ${missing.map((item) => item.label).join(", ")}.`);
      mappings = Object.fromEntries(variables.map((variable) => [variable.key, mappings[variable.key]]));
      templateName = templateResult.data.name;
      templateLanguage = templateResult.data.language;
    } else {
      mappings = {};
    }

    const saved = await supabaseAdmin.from("whatsapp_notification_configs").upsert({
      company_id: companyId,
      event_code: WORKFORCE_PAYOUT_WHATSAPP_EVENT,
      is_enabled: isEnabled,
      whatsapp_profile_id: profileId,
      template_id: templateId,
      template_name: templateName,
      template_language: templateLanguage,
      variable_mappings: mappings,
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,event_code" });
    if (saved.error) throw new Error(saved.error.message);

    revalidatePath("/settings/workforce-payment");
    revalidatePath(PAGE_PATH);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    settingsRedirect({ error: error instanceof Error ? error.message : "Unable to save payout notification settings." });
  }
  settingsRedirect({ notice: "Workforce payout WhatsApp notification configuration saved." });
}

export async function syncWorkforcePayoutWhatsAppTemplates(profileId: string) {
  try {
    const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
    const companyId = requireCompanyId(authorization);
    const cleanProfileId = String(profileId ?? "").trim();
    if (!cleanProfileId) throw new Error("Select a WhatsApp sender before syncing templates.");
    const templates = await syncWhatsAppTemplateCache(companyId, cleanProfileId);
    revalidatePath(PAGE_PATH);
    return {
      templates: templates.filter((template) => template.status === "APPROVED"),
      notice: `Synced with Meta · ${templates.length} templates checked.`
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to sync WhatsApp templates." };
  }
}
