import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { saveDesignationRoute, updateRegisterMaster } from "./actions";

type RegisterRow = {
  id: string;
  code: string;
  name: string;
  table_name: string;
  profile_type: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
};

type DesignationRow = {
  id: string;
  code: string;
  name: string;
  designation_category_id: string | null;
  is_active: boolean;
};

type RouteRow = {
  id: string;
  designation_id: string;
  register_id: string | null;
  registration_enabled: boolean;
  mapping_source: string;
  reconciliation_status: string;
  last_reconciled_at: string | null;
  last_reconciliation: {
    moved?: number;
    retained?: number;
    failed?: number;
  } | null;
};

type CountRow = {
  designation_id: string;
  table_name: string;
  total_count: number;
  active_count: number;
};

function loadFlash() {
  const raw = cookies().get("dropx_designation_routing_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

function formatDate(value: string | null) {
  if (!value) return "Not run";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export const dynamic = "force-dynamic";

export default async function DesignationRoutingPage({
  searchParams
}: {
  searchParams?: { q?: string; status?: string };
}) {
  const authorization = await requirePagePermission("designations", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.designations;
  const flash = loadFlash();

  const [registerResult, designationResult, categoryResult, routeResult, countResult] = supabaseAdmin
    ? await Promise.all([
      supabaseAdmin
        .from("workforce_register_master")
        .select("id, code, name, table_name, profile_type, description, is_active, sort_order")
        .eq("company_id", companyId)
        .order("sort_order"),
      supabaseAdmin
        .from("designations")
        .select("id, code, name, designation_category_id, is_active")
        .eq("company_id", companyId)
        .order("name"),
      supabaseAdmin
        .from("designation_categories")
        .select("id, name")
        .eq("company_id", companyId),
      supabaseAdmin
        .from("designation_register_routes")
        .select("id, designation_id, register_id, registration_enabled, mapping_source, reconciliation_status, last_reconciled_at, last_reconciliation")
        .eq("company_id", companyId),
      supabaseAdmin.rpc("designation_register_counts", { p_company_id: companyId })
    ])
    : [
      { data: null, error: { message: "Supabase service role key is not configured." } },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null }
    ];

  const error = registerResult.error?.message || designationResult.error?.message || categoryResult.error?.message || routeResult.error?.message || countResult.error?.message || null;
  const registers = (registerResult.data ?? []) as RegisterRow[];
  const categories = new Map((categoryResult.data ?? []).map((row) => [String(row.id), String(row.name)]));
  const routes = new Map(((routeResult.data ?? []) as RouteRow[]).map((route) => [route.designation_id, route]));
  const registerById = new Map(registers.map((register) => [register.id, register]));
  const counts = (countResult.data ?? []) as CountRow[];
  const countsByDesignation = new Map<string, CountRow[]>();
  counts.forEach((row) => countsByDesignation.set(row.designation_id, [...(countsByDesignation.get(row.designation_id) ?? []), row]));

  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const statusFilter = String(searchParams?.status ?? "all");
  const designations = ((designationResult.data ?? []) as DesignationRow[]).filter((designation) => {
    const route = routes.get(designation.id);
    const mapped = Boolean(route?.register_id);
    if (statusFilter === "mapped" && !mapped) return false;
    if (statusFilter === "unmapped" && mapped) return false;
    if (statusFilter === "review" && !["needs_review", "failed"].includes(route?.reconciliation_status ?? "")) return false;
    return `${designation.code} ${designation.name} ${categories.get(designation.designation_category_id ?? "") ?? ""}`.toLowerCase().includes(query);
  });
  const unmappedCount = ((designationResult.data ?? []) as DesignationRow[]).filter((designation) => !routes.get(designation.id)?.register_id).length;

  return (
    <AppShell active="Designation Routing" pageCode="designations">
      <PageHead
        eyebrow="Workforce Master"
        title="Designation Routing"
        subtitle="Choose the one register that owns each designation. This master controls reconciliation and every new registration."
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Routing Master is not ready</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Apply the designation register routing migration, then refresh.</p>
          </div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Register Master</h2>
                <p className="subtle">These database rows define the available routing targets. Physical table codes are protected system identifiers.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Register</th><th>Physical table</th><th>Purpose</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  {registers.map((register) => (
                    <tr key={register.id}>
                      <td>
                        <form action={updateRegisterMaster} className="inline-actions" id={`register-${register.id}`}>
                          <input name="register_id" type="hidden" value={register.id} />
                          <input className="field" defaultValue={register.name} name="name" required style={{ minWidth: 210 }} />
                        </form>
                      </td>
                      <td><strong>{register.code}</strong><small>{register.table_name}</small></td>
                      <td>{register.description ?? "-"}</td>
                      <td>
                        <label className="check-row">
                          <input defaultChecked={register.is_active} form={`register-${register.id}`} name="is_active" type="checkbox" /> Active
                        </label>
                      </td>
                      <td>{permission.canEdit ? <SubmitButton className="button secondary compact" form={`register-${register.id}`} pendingText="Saving">Save</SubmitButton> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Designation to register mapping</h2>
                <p className="subtle">{designations.length} shown · {unmappedCount} unmapped and blocked for new registration</p>
              </div>
              <form action="/master/designation-routing" className="master-toolbar">
                <input className="field" defaultValue={searchParams?.q ?? ""} name="q" placeholder="Search designation" />
                <select className="select" defaultValue={statusFilter} name="status">
                  <option value="all">All statuses</option>
                  <option value="mapped">Mapped</option>
                  <option value="unmapped">Unmapped</option>
                  <option value="review">Needs review</option>
                </select>
                <button className="button secondary compact" type="submit">Filter</button>
              </form>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Designation</th><th>Current records</th><th>Target register</th><th>New registration</th><th>Reconciliation</th><th>Action</th></tr></thead>
                <tbody>
                  {designations.map((designation) => {
                    const route = routes.get(designation.id);
                    const register = route?.register_id ? registerById.get(route.register_id) : null;
                    const currentCounts = (countsByDesignation.get(designation.id) ?? []).filter((row) => Number(row.total_count) > 0);
                    const reconciliation = route?.last_reconciliation ?? {};
                    return (
                      <tr key={designation.id}>
                        <td>
                          <strong>{designation.name}</strong>
                          <small>{designation.code} · {categories.get(designation.designation_category_id ?? "") ?? "Uncategorised"} · {designation.is_active ? "Active" : "Inactive"}</small>
                        </td>
                        <td>
                          {currentCounts.length ? currentCounts.map((row) => (
                            <small key={row.table_name}>{row.table_name}: {Number(row.active_count)} active / {Number(row.total_count)} total</small>
                          )) : <span className="subtle">No records</span>}
                        </td>
                        <td>
                          <form action={saveDesignationRoute} id={`route-${designation.id}`}>
                            <input name="designation_id" type="hidden" value={designation.id} />
                            <select className="select" defaultValue={route?.register_id ?? ""} name="register_id">
                              <option value="">Unmapped — block registration</option>
                              {registers.filter((item) => item.is_active || item.id === route?.register_id).map((item) => (
                                <option key={item.id} value={item.id}>{item.name} ({item.table_name})</option>
                              ))}
                            </select>
                          </form>
                          <small>{register ? `Runtime target: ${register.table_name}` : "No runtime target"}</small>
                        </td>
                        <td>
                          <label className="check-row">
                            <input defaultChecked={Boolean(route?.registration_enabled)} form={`route-${designation.id}`} name="registration_enabled" type="checkbox" /> Enabled
                          </label>
                        </td>
                        <td>
                          <StatusPill status={(route?.reconciliation_status ?? "unmapped").replaceAll("_", " ")} />
                          <small>{formatDate(route?.last_reconciled_at ?? null)}</small>
                          {route?.last_reconciled_at ? <small>{reconciliation.moved ?? 0} moved · {reconciliation.failed ?? 0} failed</small> : null}
                        </td>
                        <td>
                          {permission.canEdit ? (
                            <SubmitButton
                              className="button compact"
                              confirmDescription="Existing profiles are copied into the selected register and legacy source rows are retained inactive for compatibility."
                              confirmMessage={`Save the route for ${designation.name} and reconcile its existing records?`}
                              confirmSubmitText="Save and reconcile"
                              confirmTitle="Confirm register routing"
                              form={`route-${designation.id}`}
                              pendingText="Reconciling"
                            >
                              Save & reconcile
                            </SubmitButton>
                          ) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
