
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { accessPages } from "@/lib/access-pages";
import { navItems } from "@/lib/app-navigation";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

type SearchParams = {
  role?: string;
};

type RoleRow = {
  code: string;
  id: string;
  is_active: boolean | null;
  location_access_mode: string | null;
  name: string;
};

type PageRow = {
  code: string;
  id: string;
  is_active: boolean | null;
  name: string;
  sort_order: number | null;
};

type PermissionRow = {
  can_add: boolean | null;
  can_edit: boolean | null;
  can_view: boolean | null;
  page_id: string;
};

const fallbackPages = accessPages.map((page) => ({
  ...page,
  id: page.code,
  is_active: true
}));

function permissionLabel(permission?: { canAdd: boolean; canEdit: boolean; canView: boolean }) {
  if (!permission?.canView && !permission?.canAdd && !permission?.canEdit) return "Hidden";
  const parts = [];
  if (permission.canView) parts.push("View");
  if (permission.canAdd) parts.push("Add");
  if (permission.canEdit) parts.push("Edit");
  return parts.join(" / ");
}

async function loadPreview(companyId: string, selectedRoleId?: string) {
  if (!supabaseAdmin) {
    return {
      error: "Supabase service role key is not configured.",
      pages: fallbackPages,
      permissions: new Map<string, { canAdd: boolean; canEdit: boolean; canView: boolean }>(),
      roles: [] as RoleRow[],
      selectedRole: null as RoleRow | null
    };
  }

  const { data: roles, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("id, code, name, location_access_mode, is_active")
    .eq("company_id", companyId)
    .order("name", { ascending: true });

  if (rolesError) {
    return {
      error: rolesError.message,
      pages: fallbackPages,
      permissions: new Map<string, { canAdd: boolean; canEdit: boolean; canView: boolean }>(),
      roles: [] as RoleRow[],
      selectedRole: null as RoleRow | null
    };
  }

  const activeRoles = ((roles ?? []) as RoleRow[]).filter((role) => role.is_active !== false);
  const selectedRole = activeRoles.find((role) => role.id === selectedRoleId) ?? activeRoles[0] ?? null;

  let pages = fallbackPages as PageRow[];
  const pagesResult = await supabaseAdmin
    .from("app_pages")
    .select("id, code, name, sort_order, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (!pagesResult.error && pagesResult.data?.length) {
    pages = pagesResult.data as PageRow[];
  }

  const pageById = new Map(pages.map((page) => [page.id, page]));
  const permissions = new Map<string, { canAdd: boolean; canEdit: boolean; canView: boolean }>();

  if (selectedRole?.code?.toUpperCase() === "OWNER") {
    pages.forEach((page) => permissions.set(page.code, { canView: true, canAdd: true, canEdit: true }));
  } else if (selectedRole) {
    const { data: grants, error: grantsError } = await supabaseAdmin
      .from("role_page_permissions")
      .select("page_id, can_view, can_add, can_edit")
      .eq("company_id", companyId)
      .eq("role_id", selectedRole.id);

    if (grantsError) {
      return { error: grantsError.message, pages, permissions, roles: activeRoles, selectedRole };
    }

    ((grants ?? []) as PermissionRow[]).forEach((grant) => {
      const page = pageById.get(grant.page_id);
      if (!page) return;
      permissions.set(page.code, {
        canView: Boolean(grant.can_view || grant.can_edit),
        canAdd: Boolean(grant.can_add),
        canEdit: Boolean(grant.can_edit)
      });
    });
  }

  return { error: null as string | null, pages, permissions, roles: activeRoles, selectedRole };
}

export const dynamic = "force-dynamic";

export default async function DeveloperPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("developer_mode", "access");
  const companyId = requireCompanyId(authorization);
  const preview = await loadPreview(companyId, searchParams?.role);
  const selectedRoleId = preview.selectedRole?.id ?? "";
  const canManageDevAccess = authorization.roleCode === "OWNER" || authorization.isMasterOwner;

  return (
    <AppShell active="Developer Mode" pageCode="developer_mode">
      <PageHead
        eyebrow="Settings"
        title="Developer Mode"
        subtitle="Test visibility by role before changes are pushed to production users."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {preview.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load developer preview</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{preview.error}</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Role preview</h2>
            <p className="subtle">Switch roles here to check what a user can see. This does not change your live account.</p>
          </div>
          <StatusPill status={canManageDevAccess ? "Owner controlled" : "Preview only"} />
        </div>
        <div className="panel-body">
          <form action="/developer" className="form-grid three">
            <label className="span-2">Preview as
              <select className="field" name="role" defaultValue={selectedRoleId}>
                {preview.roles.map((role) => (
                  <option key={role.id} value={role.id}>{role.name} ({role.code})</option>
                ))}
              </select>
            </label>
            <div className="form-actions align-right">
              <button className="button secondary" type="submit">Switch preview</button>
            </div>
          </form>
        </div>
      </section>

      <section className="summary-grid">
        <div className="metric-card"><span>Selected Role</span><strong>{preview.selectedRole?.name ?? "-"}</strong><small>{preview.selectedRole?.code ?? "No active role found"}</small></div>
        <div className="metric-card"><span>Location Scope</span><strong>{preview.selectedRole?.location_access_mode === "all_locations" ? "All" : "Scoped"}</strong><small>As configured in Users & Access</small></div>
        <div className="metric-card"><span>Developer Access</span><strong>{hasPermission(authorization, "developer_mode", "access") ? "On" : "Off"}</strong><small>Owner can grant custom roles</small></div>
        <div className="metric-card"><span>Pages</span><strong>{preview.pages.length}</strong><small>Active page permissions in this company</small></div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Menu visibility</h2>
            <p className="subtle">This is the menu map for the selected role, so you can test owner, manager, station, finance, HR, and custom roles.</p>
          </div>
        </div>
        <div className="table-wrap">
          <ReportTable>
            <thead>
              <tr>
                <th>Menu</th>
                <th>Section</th>
                <th>Permission</th>
                <th>Route</th>
              </tr>
            </thead>
            <tbody>
              {navItems.flatMap((item) => {
                const children = item.children?.length ? item.children : [{ code: item.code, href: item.href, label: item.label }];
                return children.map((child) => {
                  const permission = preview.permissions.get(child.code ?? "");
                  return (
                    <tr key={`${item.label}-${child.label}`}>
                      <td><strong>{item.label}</strong></td>
                      <td>{child.label}</td>
                      <td><StatusPill status={permissionLabel(permission)} /></td>
                      <td>{child.href ?? "-"}</td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </ReportTable>
        </div>
      </section>
    </AppShell>
  );
}
