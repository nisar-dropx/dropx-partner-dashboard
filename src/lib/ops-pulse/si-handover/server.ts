import "server-only";
import {
  getAuthorization,
  hasPermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { allAuditRows } from "../station-audit-query";
import {
  SI_TEMPLATE_FORMAT,
  canRead,
  defaultSettings,
  isManager,
  isSi,
  normalizeSettings,
  tasks,
  type Actor,
  type Evidence,
  type Master,
  type Settings,
  type SiChecklist,
  type Template,
} from "./model";
import { defaultSiTemplate } from "./template";

export function db() {
  if (!supabaseAdmin) throw Error("Database service unavailable.");
  return supabaseAdmin;
}

function actorFromAuth(auth: AuthorizationContext): Actor {
  return {
    userId: auth.userId,
    displayName: auth.fullName?.trim() || auth.email || "User",
    isMasterOwner: Boolean(auth.isMasterOwner),
    effectiveRoleIds: auth.effectiveRoleIds || [],
    hasAllLocationAccess: Boolean(auth.hasAllLocationAccess),
    locationScopeIds: auth.locationScopeIds || [],
    readOnly: Boolean(auth.readOnly),
    permissions: auth.permissions || {},
  };
}

async function nowModelIds(companyId: string) {
  const models = await db()
    .from("location_models")
    .select("id")
    .eq("company_id", companyId)
    .ilike("code", "NOW");
  if (models.error) throw Error(models.error.message);
  return (models.data || []).map((m) => m.id as string);
}

export async function ensureMaster(companyId: string): Promise<Master> {
  const existing = await db()
    .from("ops_si_handover_master")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();
  if (existing.error) throw Error(existing.error.message);
  if (existing.data) {
    const master = existing.data as Master;
    const settings = normalizeSettings(master.settings);
    const emptyCatalogue = !tasks(
      master.template || { name: "", description: "", sections: [] },
    ).length;
    const refreshCatalogue =
      emptyCatalogue || settings.templateFormat < SI_TEMPLATE_FORMAT;
    const missingModels = !settings.modelIds.length;
    const template = refreshCatalogue
      ? defaultSiTemplate()
      : master.template;
    if (refreshCatalogue || missingModels) {
      const nextSettings = {
        ...settings,
        templateFormat: Math.max(settings.templateFormat, SI_TEMPLATE_FORMAT),
        modelIds: missingModels
          ? await nowModelIds(companyId)
          : settings.modelIds,
      };
      const patched = await db()
        .from("ops_si_handover_master")
        .update({
          template,
          settings: nextSettings,
          updated_at: new Date().toISOString(),
          version: master.version + 1,
        })
        .eq("company_id", companyId)
        .eq("version", master.version)
        .select("*")
        .maybeSingle();
      if (patched.error) throw Error(patched.error.message);
      if (patched.data) {
        return {
          ...(patched.data as Master),
          settings: normalizeSettings((patched.data as Master).settings),
          template,
        };
      }
      return {
        ...master,
        settings: nextSettings,
        template,
      };
    }
    return { ...master, settings, template };
  }
  const template = defaultSiTemplate();
  const settings = defaultSettings();
  settings.modelIds = await nowModelIds(companyId);
  const inserted = await db()
    .from("ops_si_handover_master")
    .insert({
      company_id: companyId,
      template,
      settings,
      version: 1,
    })
    .select("*")
    .single();
  if (inserted.error) throw Error(inserted.error.message);
  return {
    ...(inserted.data as Master),
    settings: normalizeSettings((inserted.data as Master).settings),
  };
}

export async function context(write = false, masterPage = false) {
  const auth = await getAuthorization();
  const code = masterPage ? "si_handover_master" : "si_handover";
  if (
    !auth?.companyId ||
    !hasPermission(auth, code, write ? "edit" : "access") ||
    (write && auth.readOnly)
  )
    throw Error("SI handover access denied.");
  const master = await ensureMaster(auth.companyId);
  return {
    auth,
    actor: actorFromAuth(auth),
    companyId: auth.companyId,
    master,
  };
}

export async function stores(auth: AuthorizationContext, settings: Settings) {
  if (!settings.modelIds.length) return [];
  let q = db()
    .from("stations")
    .select(
      "id,station_code,station_name,city,location_model_id,cluster_manager_email,station_manager_email",
    )
    .eq("company_id", auth.companyId!)
    .eq("is_active", true)
    .eq("hide_from_location_list", false)
    .eq("is_ho", false)
    .in("location_model_id", settings.modelIds);
  if (!auth.hasAllLocationAccess) {
    if (!auth.locationScopeIds.length) return [];
    q = q.in("id", auth.locationScopeIds);
  }
  const r = await allAuditRows((from, to) =>
    q.order("station_code").range(from, to),
  );
  if (r.error) throw Error(r.error.message);
  return r.data || [];
}

export async function readChecklist(
  id: string,
  ctx?: Awaited<ReturnType<typeof context>>,
) {
  const c = ctx || (await context());
  const r = await db()
    .from("ops_si_shift_checklists")
    .select("*")
    .eq("company_id", c.companyId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (r.error) throw Error(r.error.message);
  const row = r.data as SiChecklist | null;
  if (!row || !canRead(c.actor, c.master.settings, row))
    throw Error("Checklist unavailable in your store scope.");
  return { ...c, checklist: row };
}

export async function proofs(companyId: string, checklistId: string) {
  const r = await db()
    .from("ops_si_checklist_evidence")
    .select("*")
    .eq("company_id", companyId)
    .eq("checklist_id", checklistId)
    .eq("ready", true)
    .order("created_at");
  if (r.error) throw Error(r.error.message);
  return (r.data || []) as Evidence[];
}

export async function listChecklists(
  auth: AuthorizationContext,
  master: Master,
  opts: {
    from: string;
    to: string;
    locationId?: string;
    status?: string[];
  },
) {
  const locations = await stores(auth, master.settings);
  const ids = opts.locationId
    ? locations.filter((l) => l.id === opts.locationId).map((l) => l.id)
    : locations.map((l) => l.id);
  if (!ids.length) return { locations, rows: [] as SiChecklist[] };
  let q = db()
    .from("ops_si_shift_checklists")
    .select("*")
    .eq("company_id", auth.companyId!)
    .in("location_id", ids)
    .is("deleted_at", null)
    .gte("shift_date", opts.from)
    .lte("shift_date", opts.to)
    .order("shift_date", { ascending: false })
    .order("shift_slot", { ascending: false });
  if (opts.status?.length) q = q.in("status", opts.status);
  const r = await allAuditRows((from, to) => q.range(from, to));
  if (r.error) throw Error(r.error.message);
  return { locations, rows: (r.data || []) as SiChecklist[] };
}

export function event(
  actor: Actor,
  kind: string,
  note = "",
): SiChecklist["events"][number] {
  return {
    at: new Date().toISOString(),
    actor: actor.userId,
    actorName: actor.displayName,
    kind,
    note,
  };
}

export { isManager, isSi, actorFromAuth };
export type { Template };
