"use server";
import { revalidatePath } from "next/cache";
import { context, db } from "@/lib/ops-pulse/store-audits/server";
import {
  validateTemplate,
  type Template,
  type Settings,
} from "@/lib/ops-pulse/store-audits/model";
import { validAuditRecipientRule } from "@/lib/ops-pulse/station-audit-recipients";
export async function saveStoreAuditMaster(
  version: number,
  template: Template,
  settings: Settings,
) {
  try {
    const c = await context(true, true);
    validateTemplate(template);
    if (JSON.stringify(template).length > 500000)
      throw Error("Checklist is too large.");
    if (
      !settings.managerRoles.length ||
      !settings.responderRoles.length ||
      !settings.modelIds.length
    )
      throw Error(
        "Select leadership roles, store response roles and at least one operation model.",
      );
    const [roles, models] = await Promise.all([
      db()
        .from("user_roles")
        .select("id")
        .eq("company_id", c.companyId)
        .eq("is_active", true),
      db()
        .from("location_models")
        .select("id")
        .eq("company_id", c.companyId)
        .eq("is_active", true),
    ]);
    if (roles.error || models.error)
      throw Error("Could not validate the selected configuration.");
    if (
      [...settings.managerRoles, ...settings.responderRoles].some(
        (id) => !roles.data.some((r) => r.id === id),
      ) ||
      settings.modelIds.some((id) => !models.data.some((m) => m.id === id))
    )
      throw Error("Select active roles and models from this company.");
    if (
      settings.managerRoles.some((id) => settings.responderRoles.includes(id))
    )
      throw Error(
        "Keep store response roles separate from leadership roles, to preserve surprise audit visibility.",
      );
    if (
      !Array.isArray(settings.ccRules) ||
      settings.ccRules.some((r) => !validAuditRecipientRule(r)) ||
      typeof settings.emailEnabled !== "boolean"
    )
      throw Error("Select valid email recipients.");
    const r = await db()
      .from("ops_store_audit_master")
      .update({
        template,
        settings,
        version: version + 1,
        updated_by: c.auth.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", c.companyId)
      .eq("version", version)
      .select("version")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data)
      throw Error("Another user changed the master. Reload before saving.");
    revalidatePath("/ops-pulse/master/store-audits");
    revalidatePath("/master/store-audits");
    revalidatePath("/ops-pulse/store-audits");
    return {
      ok: true as const,
      message:
        "Master saved. New audits will use this version; existing audits retain their checklist.",
      version: r.data.version,
    };
  } catch (e) {
    return {
      ok: false as const,
      message: e instanceof Error ? e.message : "Unable to save configuration.",
    };
  }
}
