import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { formatDashboardDate } from "@/lib/date-format";
import { platformModules } from "@/lib/platform-modules";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { signOut } from "@/app/login/actions";
import {
  createControlPanelUser,
  createPlatformCompany,
  deleteControlPanelUser,
  deletePlatformCompany,
  updateControlPanelUser,
  updatePlatformCompany
} from "./actions";

type CompanyRow = {
  id: string;
  code: string;
  name: string;
  admin_name: string | null;
  admin_email: string | null;
  admin_mobile: string | null;
  is_master: boolean;
  is_active: boolean;
  created_at: string;
};

type CompanyModuleRow = {
  company_id: string;
  module_code: string;
  is_enabled: boolean;
};

type ControlUserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
};

function loadFlash() {
  const raw = cookies().get("dropx_platform_admin_flash")?.value;
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

function formatDate(value: string) {
  return formatDashboardDate(value);
}

async function loadPlatformData() {
  if (!supabaseAdmin) {
    return {
      companies: [] as CompanyRow[],
      moduleRows: [] as CompanyModuleRow[],
      controlUsers: [] as ControlUserRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const [companyResult, moduleResult] = await Promise.all([
    supabaseAdmin
      .from("companies")
      .select("id, code, name, admin_name, admin_email, admin_mobile, is_master, is_active, created_at")
      .order("is_master", { ascending: false })
      .order("name", { ascending: true }),
    supabaseAdmin
      .from("company_module_access")
      .select("company_id, module_code, is_enabled")
  ]);

  if (companyResult.error) {
    return { companies: [] as CompanyRow[], moduleRows: [] as CompanyModuleRow[], controlUsers: [] as ControlUserRow[], error: companyResult.error.message };
  }
  if (moduleResult.error) {
    return { companies: companyResult.data as CompanyRow[] ?? [], moduleRows: [] as CompanyModuleRow[], controlUsers: [] as ControlUserRow[], error: moduleResult.error.message };
  }

  const companies = (companyResult.data ?? []) as CompanyRow[];
  const masterCompanyId = companies.find((company) => company.is_master)?.id ?? null;
  let controlUsers: ControlUserRow[] = [];
  if (masterCompanyId) {
    const { data, error: controlUserError } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, is_active")
      .eq("company_id", masterCompanyId)
      .eq("is_master_owner", true)
      .order("full_name", { ascending: true });
    if (controlUserError) {
      return { companies, moduleRows: (moduleResult.data ?? []) as CompanyModuleRow[], controlUsers: [] as ControlUserRow[], error: controlUserError.message };
    }
    controlUsers = (data ?? []) as ControlUserRow[];
  }

  return {
    companies,
    moduleRows: (moduleResult.data ?? []) as CompanyModuleRow[],
    controlUsers,
    error: null
  };
}

function getCompanyModuleCodes(companyId: string, moduleRows: CompanyModuleRow[]) {
  return new Set(
    moduleRows
      .filter((row) => row.company_id === companyId && row.is_enabled)
      .map((row) => row.module_code)
  );
}

function moduleSummary(companyId: string, moduleRows: CompanyModuleRow[]) {
  const enabled = getCompanyModuleCodes(companyId, moduleRows);
  if (!enabled.size) return <span className="subtle">No modules enabled</span>;
  const labels = platformModules.filter((module) => enabled.has(module.code)).map((module) => module.name);
  const visible = labels.slice(0, 4);
  return (
    <div className="platform-module-tags">
      {visible.map((label) => <span key={label} className="mini-tag">{label}</span>)}
      {labels.length > visible.length ? <span className="mini-tag neutral">+{labels.length - visible.length}</span> : null}
    </div>
  );
}

function ModuleChecklist({
  companyId,
  moduleRows
}: {
  companyId?: string;
  moduleRows: CompanyModuleRow[];
}) {
  const enabled = companyId ? getCompanyModuleCodes(companyId, moduleRows) : new Set(platformModules.map((module) => module.code));
  return (
    <div className="platform-module-grid">
      {platformModules.map((module) => (
        <label key={module.code} className="platform-module-check">
          <input
            name="module_codes"
            type="checkbox"
            value={module.code}
            defaultChecked={enabled.has(module.code)}
          />
          <span>{module.name}</span>
        </label>
      ))}
    </div>
  );
}

function CompanyForm({
  action,
  initial,
  moduleRows,
  submitLabel
}: {
  action: (formData: FormData) => void;
  initial?: CompanyRow | null;
  moduleRows: CompanyModuleRow[];
  submitLabel: string;
}) {
  return (
    <form action={action} className="platform-company-form">
      {initial ? <input name="id" type="hidden" value={initial.id} /> : null}
      <div className="form-grid three">
        <label>
          Company code
          <input
            className="field"
            defaultValue={initial?.code ?? ""}
            name="code"
            placeholder="COMPANY_CODE"
            readOnly={initial?.is_master}
            required
          />
        </label>
        <label>
          Company name
          <input className="field" defaultValue={initial?.name ?? ""} name="name" placeholder="Company name" required />
        </label>
        <label>
          Admin name
          <input className="field" defaultValue={initial?.admin_name ?? ""} name="admin_name" placeholder="Admin name" required />
        </label>
        <label>
          Admin email
          <input className="field" defaultValue={initial?.admin_email ?? ""} name="admin_email" placeholder="admin@example.com" type="email" required />
        </label>
        <label>
          Admin mobile
          <input className="field" defaultValue={initial?.admin_mobile ?? ""} name="admin_mobile" placeholder="10 digit mobile" required />
        </label>
        {initial ? (
          <label>
            Status
            <select className="field" defaultValue={initial.is_active ? "active" : "inactive"} name="status">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        ) : null}
      </div>

      <div className="platform-form-section">
        <div>
          <h3>Allowed modules</h3>
          <p className="subtle">Select the product areas this company can use.</p>
        </div>
        <ModuleChecklist companyId={initial?.id} moduleRows={moduleRows} />
      </div>

      {initial?.is_master ? (
        <p className="subtle">DROPX LOGISTICS is the master company. The code is protected.</p>
      ) : null}

      <div className="form-actions right">
        <SubmitButton className="button" pendingText="Saving">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function ControlUserForm({
  action,
  initial,
  submitLabel
}: {
  action: (formData: FormData) => void;
  initial?: ControlUserRow | null;
  submitLabel: string;
}) {
  return (
    <form action={action} className="platform-company-form">
      {initial ? <input name="id" type="hidden" value={initial.id} /> : null}
      <div className="form-grid three">
        <label>
          Name
          <input className="field" defaultValue={initial?.full_name ?? ""} name="full_name" placeholder="User name" required />
        </label>
        <label>
          Email
          <input className="field" defaultValue={initial?.email ?? ""} name="email" placeholder="name@example.com" type="email" required />
        </label>
        {initial ? (
          <label>
            Status
            <select className="field" defaultValue={initial.is_active ? "active" : "inactive"} name="status">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        ) : null}
      </div>
      <div className="form-actions right">
        <SubmitButton className="button" pendingText="Saving">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage({
  searchParams
}: {
  searchParams?: { add?: string; edit?: string; addUser?: string; editUser?: string; q?: string };
}) {
  await requirePagePermission("company_master", "access");
  const { companies, moduleRows, controlUsers, error } = await loadPlatformData();
  const flash = loadFlash();
  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const filteredCompanies = companies.filter((company) =>
    `${company.code} ${company.name} ${company.admin_name ?? ""} ${company.admin_email ?? ""} ${company.admin_mobile ?? ""}`
      .toLowerCase()
      .includes(query)
  );
  const editCompany = companies.find((company) => company.id === searchParams?.edit) ?? null;
  const editControlUser = controlUsers.find((user) => user.id === searchParams?.editUser) ?? null;

  return (
    <main className="platform-admin-page">
      <header className="platform-admin-header">
        <div className="platform-admin-brand">
          <Image src="/dropx-logo.png" alt="DropX" width={112} height={40} priority />
          <div>
            <p className="eyebrow">Platform Admin</p>
            <h1>Company Control Panel</h1>
          </div>
        </div>
        <div className="platform-admin-actions">
          <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>
            {isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}
          </span>
          <Link href="https://dashboard.dropxlogistics.com/dashboard" className="button secondary compact">Dashboard</Link>
          <form action={signOut} className="platform-signout-form">
            <button className="button secondary compact" type="submit">Sign out</button>
          </form>
        </div>
      </header>

      <section className="platform-hero panel">
        <div>
          <p className="eyebrow">SaaS Setup</p>
          <h2>Companies and product access</h2>
          <p className="subtle">Create tenant companies and choose which modules are available to each company.</p>
        </div>
        <div className="platform-hero-metrics">
          <div><strong>{companies.length}</strong><span>Companies</span></div>
          <div><strong>{companies.filter((company) => company.is_active).length}</strong><span>Active</span></div>
          <div><strong>{platformModules.length}</strong><span>Modules</span></div>
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/company_master_v1.sql` in Supabase SQL Editor, then refresh this page.
            </p>
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
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Control panel users</h2>
              <p className="subtle">Users listed here can add, edit, and delete companies.</p>
            </div>
            <PendingLink className="button compact" href="/platform-admin?addUser=1" scroll={false}>Add user</PendingLink>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {controlUsers.length ? controlUsers.map((user) => (
                  <tr key={user.id}>
                    <td><strong>{user.full_name ?? "-"}</strong></td>
                    <td>{user.email ?? "-"}</td>
                    <td><StatusPill status={user.is_active ? "Active" : "Inactive"} /></td>
                    <td>
                      <PendingLink className="button secondary compact" href={`/platform-admin?editUser=${user.id}`} scroll={false}>Edit</PendingLink>
                    </td>
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={4}>No control panel users added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Company list</h2>
              <p className="subtle">{filteredCompanies.length} of {companies.length} records</p>
            </div>
            <div className="master-toolbar">
              <form className="inline-search" action="/platform-admin">
                <input className="field" defaultValue={searchParams?.q ?? ""} name="q" placeholder="Search company or email" />
                <button className="button secondary compact" type="submit">Search</button>
                {query ? <PendingLink className="button secondary compact" href="/platform-admin">Clear</PendingLink> : null}
              </form>
              <PendingLink className="button compact" href="/platform-admin?add=1" scroll={false}>Add company</PendingLink>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Company admin</th>
                  <th>Type</th>
                  <th>Modules</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredCompanies.length ? filteredCompanies.map((company) => (
                  <tr key={company.id}>
                    <td>
                      <strong>{company.name}</strong>
                      <div className="subtle">{company.code}</div>
                    </td>
                    <td>
                      <strong>{company.admin_name ?? "-"}</strong>
                      <div className="subtle">{company.admin_email ?? "-"}</div>
                      <div className="subtle">{company.admin_mobile ?? "-"}</div>
                    </td>
                    <td>
                      <span className={`status-pill ${company.is_master ? "warn" : "neutral"}`}>
                        {company.is_master ? "Master" : "Tenant"}
                      </span>
                    </td>
                    <td>{moduleSummary(company.id, moduleRows)}</td>
                    <td>{formatDate(company.created_at)}</td>
                    <td><StatusPill status={company.is_active ? "Active" : "Inactive"} /></td>
                    <td>
                      <PendingLink className="button secondary compact" href={`/platform-admin?edit=${company.id}`} scroll={false}>Edit</PendingLink>
                    </td>
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={7}>No companies found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!error && searchParams?.add === "1" ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Add company</h2>
                <p className="subtle">Create a tenant company and enable product modules.</p>
              </div>
              <PendingLink className="icon-button" href="/platform-admin" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <CompanyForm action={createPlatformCompany} moduleRows={moduleRows} submitLabel="Add company" />
          </section>
        </div>
      ) : null}

      {!error && searchParams?.addUser === "1" ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Add control panel user</h2>
                <p className="subtle">Add a user who can maintain platform companies.</p>
              </div>
              <PendingLink className="icon-button" href="/platform-admin" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <ControlUserForm action={createControlPanelUser} submitLabel="Add user" />
          </section>
        </div>
      ) : null}

      {!error && editCompany ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Edit company</h2>
                <p className="subtle">Update company details and module access.</p>
              </div>
              <div className="platform-modal-head-actions">
                {!editCompany.is_master ? (
                  <form action={deletePlatformCompany}>
                    <input name="id" type="hidden" value={editCompany.id} />
                    <SubmitButton
                      className="button danger compact"
                      pendingText="Deleting"
                      confirmTitle="Delete company"
                      confirmDescription={`This will delete ${editCompany.name} from the control panel.`}
                      confirmMessage="Do you want to delete this company?"
                      confirmCancelText="Cancel"
                      confirmSubmitText="Delete company"
                    >
                      Delete
                    </SubmitButton>
                  </form>
                ) : null}
                <PendingLink className="icon-button" href="/platform-admin" scroll={false} aria-label="Close">x</PendingLink>
              </div>
            </div>
            <CompanyForm action={updatePlatformCompany} initial={editCompany} moduleRows={moduleRows} submitLabel="Save changes" />
          </section>
        </div>
      ) : null}

      {!error && editControlUser ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Edit control panel user</h2>
                <p className="subtle">Update platform access for this user.</p>
              </div>
              <div className="platform-modal-head-actions">
                <form action={deleteControlPanelUser}>
                  <input name="id" type="hidden" value={editControlUser.id} />
                  <SubmitButton
                    className="button danger compact"
                    pendingText="Deleting"
                    confirmTitle="Delete user"
                    confirmDescription={`This will remove ${editControlUser.email ?? "this user"} from the company control panel.`}
                    confirmMessage="Do you want to delete this control panel user?"
                    confirmCancelText="Cancel"
                    confirmSubmitText="Delete user"
                  >
                    Delete
                  </SubmitButton>
                </form>
                <PendingLink className="icon-button" href="/platform-admin" scroll={false} aria-label="Close">x</PendingLink>
              </div>
            </div>
            <ControlUserForm action={updateControlPanelUser} initial={editControlUser} submitLabel="Save changes" />
          </section>
        </div>
      ) : null}
    </main>
  );
}
