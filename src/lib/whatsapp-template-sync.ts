import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { listMetaTemplates } from "@/lib/whatsapp-template-meta";
import type { WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

export type SyncedWhatsAppTemplate = {
  template_id: string;
  whatsapp_profile_id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: WhatsAppTemplateComponent[];
  synced_at: string;
  rejected_reason: string;
};

/**
 * Fetches the complete paginated template list for one company-owned sender and
 * reconciles its cache only after Meta has returned every page successfully.
 */
export async function syncWhatsAppTemplateCache(companyId: string, profileId: string) {
  if (!supabaseAdmin) throw new Error("WhatsApp storage is unavailable.");

  const profileResult = await supabaseAdmin
    .from("whatsapp_profiles")
    .select("id,business_account_id,graph_api_version,is_active")
    .eq("company_id", companyId)
    .eq("id", profileId)
    .maybeSingle();
  if (profileResult.error || !profileResult.data?.is_active) {
    throw new Error("Select an active sender in your company.");
  }
  if (!profileResult.data.business_account_id) {
    throw new Error("The sender is missing its WhatsApp Business Account ID.");
  }

  const tokenResult = await supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: profileId });
  if (tokenResult.error || !tokenResult.data) {
    throw new Error("The sender's WhatsApp access token is not configured.");
  }

  const metaRows = await listMetaTemplates(
    profileResult.data.graph_api_version || "v25.0",
    profileResult.data.business_account_id,
    String(tokenResult.data)
  );
  const syncedAt = new Date().toISOString();
  const templates = metaRows.filter((row) => row.id).map((row) => ({
    company_id: companyId,
    template_id: String(row.id),
    whatsapp_profile_id: profileId,
    name: String(row.name || ""),
    language: String(row.language || ""),
    category: row.category ? String(row.category) : null,
    status: String(row.status || "UNKNOWN"),
    components: (Array.isArray(row.components) ? row.components : []) as WhatsAppTemplateComponent[],
    synced_at: syncedAt
  }));

  if (templates.length) {
    const saved = await supabaseAdmin
      .from("whatsapp_template_cache")
      .upsert(templates, { onConflict: "company_id,template_id" });
    if (saved.error) throw new Error("Meta responded, but templates could not be saved. Please sync again.");
  }

  // Reconciliation is intentionally last: an incomplete provider response can
  // never mark previously cached templates as deleted.
  const cached = await supabaseAdmin
    .from("whatsapp_template_cache")
    .select("template_id")
    .eq("company_id", companyId)
    .eq("whatsapp_profile_id", profileId);
  if (cached.error) throw new Error("Could not reconcile the saved template list.");
  const liveIds = new Set(templates.map((row) => row.template_id));
  const removed = (cached.data ?? [])
    .map((row) => String(row.template_id))
    .filter((templateId) => !liveIds.has(templateId));
  if (removed.length) {
    const updated = await supabaseAdmin
      .from("whatsapp_template_cache")
      .update({ status: "DELETED", synced_at: syncedAt })
      .eq("company_id", companyId)
      .eq("whatsapp_profile_id", profileId)
      .in("template_id", removed);
    if (updated.error) throw new Error("Could not reconcile removed templates. Please sync again.");
  }

  return templates.map((row) => ({
    template_id: row.template_id,
    whatsapp_profile_id: row.whatsapp_profile_id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    components: row.components,
    synced_at: row.synced_at,
    rejected_reason: String(metaRows.find((item) => String(item.id) === row.template_id)?.rejected_reason || "")
  })) satisfies SyncedWhatsAppTemplate[];
}
