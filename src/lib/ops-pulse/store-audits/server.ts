import "server-only";
import {
  getAuthorization,
  hasPermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadAuditAssignees } from "../station-audit-people";
import { allAuditRows } from "../station-audit-query";
import {
  canRead,
  isManager,
  inScope,
  type Master,
  type StoreAudit,
  type Proof,
} from "./model";
export function db() {
  if (!supabaseAdmin) throw Error("Database service unavailable.");
  return supabaseAdmin;
}
export async function context(write = false, masterPage = false) {
  const auth = await getAuthorization();
  const code = masterPage ? "store_audit_master" : "store_audits";
  if (
    !auth?.companyId ||
    !hasPermission(auth, code, write ? "edit" : "access") ||
    (write && auth.readOnly)
  )
    throw Error("Store audit access denied.");
  const m = await db()
    .from("ops_store_audit_master")
    .select("*")
    .eq("company_id", auth.companyId)
    .maybeSingle();
  if (m.error) throw Error("Store audit configuration could not be loaded.");
  if (!m.data) throw Error("Store Audit Master is not configured yet.");
  return { auth, companyId: auth.companyId, master: m.data as Master };
}
export async function stores(auth: AuthorizationContext, master: Master) {
  if (!master.settings.modelIds.length) return [];
  let q = db()
    .from("stations")
    .select(
      "id,station_code,station_name,city,location_model_id,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email",
    )
    .eq("company_id", master.company_id)
    .eq("is_active", true)
    .eq("hide_from_location_list", false)
    .eq("is_ho", false)
    .in("location_model_id", master.settings.modelIds);
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
export async function readAudit(
  id: string,
  ctx?: Awaited<ReturnType<typeof context>>,
) {
  const c = ctx || (await context());
  const r = await db()
    .from("ops_store_audits")
    .select("*")
    .eq("company_id", c.companyId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (r.error) throw Error(r.error.message);
  const audit = r.data as StoreAudit | null;
  // Historical records remain visible in authorized locations even if a model is later removed.
  if (!audit || !canRead(c.auth, c.master.settings, audit))
    throw Error("Audit unavailable in your store scope.");
  return { ...c, audit };
}
export async function proofs(c: { companyId: string }, auditId: string) {
  const r = await db()
    .from("ops_store_audit_evidence")
    .select("*")
    .eq("company_id", c.companyId)
    .eq("audit_id", auditId)
    .eq("ready", true)
    .order("created_at");
  if (r.error) throw Error(r.error.message);
  return (r.data || []) as Proof[];
}
export async function workspace(
  auth: AuthorizationContext,
  master: Master,
  from: string,
  to: string,
) {
  const locations = await stores(auth, master);
  const manager = isManager(auth, master.settings);
  let q = db()
    .from("ops_store_audits")
    .select(
      "id,number,location_id,store_name,assigned_to,assigned_name,scheduled_for,status,completed_at,findings,answers,version,email_error",
    )
    .eq("company_id", master.company_id)
    .is("deleted_at", null)
    .gte("scheduled_for", `${from}T00:00:00+05:30`)
    .lte("scheduled_for", `${to}T23:59:59+05:30`);
  if (!auth.hasAllLocationAccess) {
    if (!auth.locationScopeIds.length)
      return { locations, audits: [], assignees: [], manager };
    q = q.in("location_id", auth.locationScopeIds);
  }
  if (!manager)
    q = q
      .not("completed_at", "is", null)
      .in("status", ["awaiting_response", "under_review", "closed"]);
  const [r, assignees] = await Promise.all([
    allAuditRows((a, b) =>
      q.order("scheduled_for", { ascending: false }).order("id").range(a, b),
    ),
    manager
      ? loadAuditAssignees(
          master.company_id,
          master.settings.managerRoles,
          locations.map((l) => l.id),
          "store_audits",
        )
      : [],
  ]);
  if (r.error) throw Error(r.error.message);
  return {
    locations,
    audits: (r.data || []) as StoreAudit[],
    assignees,
    manager,
  };
}
export async function updateAudit(
  c: Awaited<ReturnType<typeof readAudit>>,
  patch: Partial<StoreAudit>,
  kind: string,
  note: string,
  expectedVersion: number,
) {
  if (c.auth.readOnly) throw Error("Preview is read-only.");
  if (c.audit.version !== expectedVersion)
    throw Error("This audit changed in another window. Refresh before saving.");
  const events = [
    ...c.audit.events,
    {
      at: new Date().toISOString(),
      actor: c.auth.fullName || c.auth.email || c.auth.userId,
      kind,
      note,
    },
  ];
  const r = await db()
    .from("ops_store_audits")
    .update({ ...patch, events, version: c.audit.version + 1 })
    .eq("company_id", c.companyId)
    .eq("id", c.audit.id)
    .eq("version", expectedVersion)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (r.error) throw Error(r.error.message);
  if (!r.data)
    throw Error("This audit changed in another window. Refresh before saving.");
  return r.data as StoreAudit;
}
export function requireManager(
  c: Awaited<ReturnType<typeof context>>,
  action: "add" | "edit" = "edit",
) {
  if (
    c.auth.readOnly ||
    !isManager(c.auth, c.master.settings) ||
    !hasPermission(c.auth, "store_audits", action)
  )
    throw Error(
      "Only configured leadership roles with this permission can manage store audits.",
    );
}
export { inScope };
