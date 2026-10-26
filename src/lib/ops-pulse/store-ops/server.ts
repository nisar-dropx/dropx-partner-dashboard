import "server-only";
import {
  getAuthorization,
  hasPermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { allAuditRows } from "../station-audit-query";
import {
  STORE_OPS_TEMPLATE_FORMAT,
  answerLooksComplete,
  canRead,
  defaultSettings,
  isFiller,
  isManager,
  monthKey,
  normalizeSettings,
  tasks,
  todayIst,
  weekStartMonday,
  type Actor,
  type Evidence,
  type Master,
  type Settings,
  type StoreOpsChecklist,
  type TaskAnswer,
  type Template,
} from "./model";
import { defaultStoreOpsTemplate } from "./template";

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
    roleCodes: auth.effectiveRoleCodes || [],
    roleCode: auth.roleCode || null,
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
    .from("ops_store_ops_master")
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
    const refresh =
      emptyCatalogue || settings.templateFormat < STORE_OPS_TEMPLATE_FORMAT;
    const missingModels = !settings.modelIds.length;
    const template = refresh ? defaultStoreOpsTemplate() : master.template;
    if (refresh || missingModels) {
      const nextSettings = {
        ...settings,
        templateFormat: Math.max(
          settings.templateFormat,
          STORE_OPS_TEMPLATE_FORMAT,
        ),
        modelIds: missingModels
          ? await nowModelIds(companyId)
          : settings.modelIds,
      };
      const patched = await db()
        .from("ops_store_ops_master")
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
      return { ...master, settings: nextSettings, template };
    }
    return { ...master, settings, template };
  }
  const template = defaultStoreOpsTemplate();
  const settings = defaultSettings();
  settings.modelIds = await nowModelIds(companyId);
  const inserted = await db()
    .from("ops_store_ops_master")
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
  const code = masterPage ? "store_ops_master" : "store_ops";
  if (
    !auth?.companyId ||
    !hasPermission(auth, code, write ? "edit" : "access") ||
    (write && auth.readOnly)
  )
    throw Error("Store operations access denied.");
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
      "id,station_code,station_name,city,location_model_id",
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
    .from("ops_store_ops_checklists")
    .select("*")
    .eq("company_id", c.companyId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (r.error) throw Error(r.error.message);
  const row = r.data as StoreOpsChecklist | null;
  if (!row || !canRead(c.actor, c.master.settings, row))
    throw Error("Checklist unavailable in your store scope.");
  return { ...c, checklist: row };
}

export async function proofs(companyId: string, checklistId: string) {
  const r = await db()
    .from("ops_store_ops_evidence")
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
  opts: { from: string; to: string; locationId?: string; status?: string[] },
) {
  const locations = await stores(auth, master.settings);
  const ids = opts.locationId
    ? locations.filter((l) => l.id === opts.locationId).map((l) => l.id)
    : locations.map((l) => l.id);
  if (!ids.length) return { locations, rows: [] as StoreOpsChecklist[] };
  let q = db()
    .from("ops_store_ops_checklists")
    .select("*")
    .eq("company_id", auth.companyId!)
    .in("location_id", ids)
    .is("deleted_at", null)
    .gte("work_date", opts.from)
    .lte("work_date", opts.to)
    .order("work_date", { ascending: false });
  if (opts.status?.length) q = q.in("status", opts.status);
  const r = await allAuditRows((from, to) => q.range(from, to));
  if (r.error) throw Error(r.error.message);
  return { locations, rows: (r.data || []) as StoreOpsChecklist[] };
}

/** Task ids already completed earlier in the same Mon–Sun week / calendar month. */
export async function periodCompletions(
  companyId: string,
  locationId: string,
  workDate: string,
  excludeId?: string,
) {
  const weekStart = weekStartMonday(workDate);
  const month = monthKey(workDate);
  const monthStart = `${month}-01`;
  const rangeStart = weekStart < monthStart ? weekStart : monthStart;
  const weekEnd = (() => {
    const d = new Date(`${weekStart}T12:00:00+05:30`);
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const r = await db()
    .from("ops_store_ops_checklists")
    .select("id,work_date,answers,template,status")
    .eq("company_id", companyId)
    .eq("location_id", locationId)
    .eq("status", "submitted")
    .is("deleted_at", null)
    .gte("work_date", rangeStart)
    .lte("work_date", workDate);
  if (r.error) throw Error(r.error.message);
  const weeklyDone = new Set<string>();
  const monthlyDone = new Set<string>();
  for (const row of r.data || []) {
    if (excludeId && row.id === excludeId) continue;
    const answers = (row.answers || {}) as Record<string, TaskAnswer>;
    const date = String(row.work_date);
    const catalogue = tasks(
      (row.template || { name: "", description: "", sections: [] }) as Template,
    );
    for (const task of catalogue) {
      if (task.frequency !== "weekly" && task.frequency !== "monthly") continue;
      if (!answerLooksComplete(task, answers[task.id])) continue;
      if (
        task.frequency === "weekly" &&
        date >= weekStart &&
        date <= weekEnd
      ) {
        weeklyDone.add(task.id);
      }
      if (task.frequency === "monthly" && date.startsWith(month)) {
        monthlyDone.add(task.id);
      }
    }
  }
  return { weeklyDone, monthlyDone };
}

export function event(
  actor: Actor,
  kind: string,
  note = "",
): StoreOpsChecklist["events"][number] {
  return {
    at: new Date().toISOString(),
    actor: actor.userId,
    actorName: actor.displayName,
    kind,
    note,
  };
}

export { isFiller, isManager, actorFromAuth, todayIst };
export type { Template };
