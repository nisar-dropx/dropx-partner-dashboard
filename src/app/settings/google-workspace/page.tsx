import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import {
  GoogleWorkspaceDirectoryMapping,
  type WorkspaceDirectoryAccount,
  type WorkspaceEmployeeOption,
  type WorkspaceLocationOption
} from "@/components/google-workspace-directory-mapping";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { workspaceCredentialsConfigured } from "@/lib/google-workspace-client";
import { productDefinitions } from "@/lib/product-ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  approveWorkspaceDeletion,
  approveWorkspaceJob,
  cancelWorkspaceDeletion,
  processWorkspaceQueueNow,
  retryWorkspaceJob,
  saveDesignationWorkspacePolicy,
  saveWorkspaceSettings,
  syncWorkspaceNow,
  updateWorkspaceDeletionReview
} from "./actions";

export const dynamic = "force-dynamic";

type SettingsRow = {
  customer_id: string | null;
  primary_domain: string;
  delegated_admin_email: string | null;
  default_org_unit_path: string;
  directory_sync_enabled: boolean;
  provisioning_enabled: boolean;
  automatic_suspension_enabled: boolean;
  default_retention_days: number;
  last_sync_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
};

type DesignationRow = { id: string; code: string; name: string; is_active: boolean };
type RoleRow = { id: string; code: string; name: string };

type PolicyRow = {
  id: string;
  designation_id: string;
  issue_workspace_account: boolean;
  approval_mode: "automatic" | "manual";
  email_pattern: string;
  org_unit_path: string;
  group_emails: string[];
  access_role_id: string | null;
  product_codes: string[];
  location_access_mode: "assignment" | "all_locations" | "none";
  send_activation_email: boolean;
  retention_days: number | null;
  is_active: boolean;
};

type AccountRow = {
  id: string;
  primary_email: string;
  full_name: string;
  account_type: string;
  account_state: string;
  source_type: string | null;
  source_record_id: string | null;
  profile_id: string | null;
  org_unit_path: string;
  suspended: boolean;
  last_synced_at: string | null;
  metadata: Record<string, unknown> | null;
};

type EmployeeRow = {
  id: string;
  employee_code: string;
  full_name: string;
  is_active: boolean;
  designations: { code: string; name: string } | Array<{ code: string; name: string }> | null;
  stations: { station_code: string; station_name: string | null } | Array<{ station_code: string; station_name: string | null }> | null;
};

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  station_email: string | null;
  is_active: boolean;
};

type JobRow = {
  id: string;
  job_type: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  google_workspace_accounts: { primary_email: string; full_name: string } | Array<{ primary_email: string; full_name: string }> | null;
};

type DeletionRow = {
  id: string;
  account_id: string;
  status: string;
  eligible_at: string;
  legal_hold: boolean;
  data_transfer_status: string;
  note: string | null;
  google_workspace_accounts: { primary_email: string; full_name: string } | Array<{ primary_email: string; full_name: string }> | null;
};

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function flash() {
  const raw = cookies().get("dropx_google_workspace_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const value = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof value.error === "string" ? value.error : null,
      notice: typeof value.notice === "string" ? value.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function schemaMissing(error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return ["42P01", "PGRST204", "PGRST205"].includes(code) || message.includes("schema cache") || message.includes("does not exist");
}

async function loadPage(companyId: string) {
  if (!supabaseAdmin) return { error: "Supabase service role key is not configured.", setupPending: false } as const;
  const [settings, designations, roles, policies, accounts, employees, locations, jobs, deletions] = await Promise.all([
    supabaseAdmin.from("google_workspace_settings").select("*").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("designations").select("id,code,name,is_active").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("user_roles").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("google_workspace_designation_policies").select("*").eq("company_id", companyId).order("updated_at", { ascending: false }),
    supabaseAdmin.from("google_workspace_accounts").select("id,primary_email,full_name,account_type,account_state,source_type,source_record_id,profile_id,org_unit_path,suspended,last_synced_at,metadata")
      .eq("company_id", companyId).order("primary_email").limit(250),
    supabaseAdmin.from("employees").select("id,employee_code,full_name,is_active,designations(code,name),stations(station_code,station_name)")
      .eq("company_id", companyId).order("is_active", { ascending: false }).order("full_name").limit(5000),
    supabaseAdmin.from("stations").select("id,station_code,station_name,station_email,is_active")
      .eq("company_id", companyId).order("is_active", { ascending: false }).order("station_code").limit(5000),
    supabaseAdmin.from("google_workspace_jobs").select("id,job_type,status,attempt_count,last_error,created_at,google_workspace_accounts(primary_email,full_name)")
      .eq("company_id", companyId).order("created_at", { ascending: false }).limit(50),
    supabaseAdmin.from("google_workspace_deletion_requests").select("id,account_id,status,eligible_at,legal_hold,data_transfer_status,note,google_workspace_accounts(primary_email,full_name)")
      .eq("company_id", companyId).neq("status", "completed").order("eligible_at", { ascending: true }).limit(100)
  ]);
  const results = [settings, designations, roles, policies, accounts, employees, locations, jobs, deletions];
  const missing = results.find((result) => result.error && schemaMissing(result.error));
  if (missing) return { error: null, setupPending: true } as const;
  const failed = results.find((result) => result.error);
  if (failed?.error) return { error: failed.error.message, setupPending: false } as const;
  return {
    error: null,
    setupPending: false,
    settings: settings.data as SettingsRow | null,
    designations: (designations.data ?? []) as DesignationRow[],
    roles: (roles.data ?? []) as RoleRow[],
    policies: (policies.data ?? []) as PolicyRow[],
    accounts: (accounts.data ?? []) as AccountRow[],
    employees: (employees.data ?? []) as EmployeeRow[],
    locations: (locations.data ?? []) as LocationRow[],
    jobs: (jobs.data ?? []) as JobRow[],
    deletions: (deletions.data ?? []) as DeletionRow[]
  } as const;
}

export default async function GoogleWorkspacePage({ searchParams }: { searchParams?: { designation?: string } }) {
  const authorization = await requirePagePermission("workspace_identity", "access");
  const permission = authorization.permissions.workspace_identity;
  const companyId = requireCompanyId(authorization);
  const data = await loadPage(companyId);
  const message = flash();

  if (data.setupPending || data.error || !("settings" in data)) {
    return (
      <AppShell active="Google Mail IDs & Mapping" pageCode="workspace_identity">
        <PageHead eyebrow="Central Identity" title="Google Workspace" subtitle="Directory, identity issuance and offboarding controls for every DropX portal." />
        <section className={`panel message-panel ${data.error ? "error" : "warning"}`}>
          <div className="panel-body">
            <strong>{data.error ? "Unable to load Google Workspace" : "Database setup pending"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error ?? "Apply the committed Google Workspace lifecycle migration, then reload this page."}</p>
          </div>
        </section>
      </AppShell>
    );
  }

  const settings = data.settings ?? null;
  const designations = data.designations ?? [];
  const roles = data.roles ?? [];
  const policies = data.policies ?? [];
  const accounts = data.accounts ?? [];
  const employees = data.employees ?? [];
  const locations = data.locations ?? [];
  const jobs = data.jobs ?? [];
  const deletions = data.deletions ?? [];
  const selectedDesignationId = searchParams?.designation || designations[0]?.id || "";
  const selectedDesignation = designations.find((row) => row.id === selectedDesignationId) ?? null;
  const policy = policies.find((row) => row.designation_id === selectedDesignationId) ?? null;
  const activeAccounts = accounts.filter((row) => row.account_state === "active" && !row.suspended).length;
  const suspendedAccounts = accounts.filter((row) => row.suspended || row.account_state === "suspended").length;
  const failedJobs = jobs.filter((row) => ["failed", "blocked"].includes(row.status)).length;
  const eligibleDeletions = deletions.filter((row) => !row.legal_hold && new Date(row.eligible_at).getTime() <= Date.now()).length;
  const directoryAccounts: WorkspaceDirectoryAccount[] = accounts.map((account) => {
    const mappingSource = typeof account.metadata?.mapping_source === "string"
      ? "Manual Super Admin mapping"
      : account.source_type === "employee" || account.source_type === "location"
        ? "DropX master linked"
        : account.profile_id
          ? "Portal email matched"
          : "Not mapped";
    return {
      id: account.id,
      primaryEmail: account.primary_email,
      fullName: account.full_name,
      accountType: account.account_type,
      accountState: account.account_state,
      sourceType: account.source_type,
      sourceRecordId: account.source_record_id,
      profileId: account.profile_id,
      orgUnitPath: account.org_unit_path,
      lastSyncedAt: account.last_synced_at,
      mappingSource
    };
  });
  const directoryEmployees: WorkspaceEmployeeOption[] = employees.map((employee) => {
    const designation = first(employee.designations);
    const location = first(employee.stations);
    return {
      id: employee.id,
      employeeCode: employee.employee_code,
      fullName: employee.full_name,
      designationCode: designation?.code ?? null,
      designationName: designation?.name ?? null,
      locationCode: location?.station_code ?? null,
      locationName: location?.station_name ?? null,
      isActive: employee.is_active
    };
  });
  const directoryLocations: WorkspaceLocationOption[] = locations.map((location) => ({
    id: location.id,
    locationCode: location.station_code,
    locationName: location.station_name,
    email: location.station_email,
    isActive: location.is_active
  }));

  return (
    <AppShell active="Google Mail IDs & Mapping" pageCode="workspace_identity">
      <PageHead
        eyebrow="Central Identity"
        title="Google Workspace"
        subtitle="Sync official mail IDs, issue identities by designation, grant portal access, and suspend offboarded users from one governed master."
        action={<StatusPill status={workspaceCredentialsConfigured() && settings ? "API ready" : "Credentials missing"} />}
      />

      {message.error || message.notice ? (
        <section className={`panel message-panel ${message.error ? "error" : "success"}`}>
          <div className="panel-body"><strong>{message.error ? "Action required" : "Completed"}</strong><p className="subtle" style={{ marginTop: 6 }}>{message.error ?? message.notice}</p></div>
        </section>
      ) : null}

      <section className="summary-grid">
        <div className="metric-card"><span>Directory accounts</span><strong>{accounts.length}</strong><small>Synced mappings</small></div>
        <div className="metric-card"><span>Active</span><strong>{activeAccounts}</strong><small>Workspace identities</small></div>
        <div className="metric-card"><span>Suspended</span><strong>{suspendedAccounts}</strong><small>DropX access revoked</small></div>
        <div className="metric-card"><span>Action queue</span><strong>{failedJobs + eligibleDeletions}</strong><small>{failedJobs} job issues · {eligibleDeletions} deletion-ready</small></div>
      </section>

      <section className="panel">
        <div className="panel-head toolbar">
          <div><h2>Connection master</h2><p className="subtle">Authentication uses keyless workload identity. This master stores only tenant configuration and lifecycle switches.</p></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <form action={syncWorkspaceNow}><SubmitButton className="button secondary" disabled={!permission?.canEdit || !settings?.directory_sync_enabled || !workspaceCredentialsConfigured()} pendingText="Syncing">Test & sync</SubmitButton></form>
            <form action={processWorkspaceQueueNow}><SubmitButton disabled={!permission?.canEdit || !settings?.provisioning_enabled || !workspaceCredentialsConfigured()} pendingText="Processing">Process queue</SubmitButton></form>
          </div>
        </div>
        <form action={saveWorkspaceSettings} className="panel-body form-grid three">
          <label>Primary domain<input className="field" defaultValue={settings?.primary_domain ?? ""} name="primary_domain" placeholder="dropxlogistics.com" required /></label>
          <label>Customer ID<input className="field" defaultValue={settings?.customer_id ?? ""} name="customer_id" placeholder="my_customer or C…" /></label>
          <label>Delegated Super Admin<input className="field" defaultValue={settings?.delegated_admin_email ?? ""} name="delegated_admin_email" placeholder="admin@yourdomain.com" required type="email" /></label>
          <label>Default organisational unit<input className="field" defaultValue={settings?.default_org_unit_path ?? "/"} name="default_org_unit_path" placeholder="/DropX" required /></label>
          <label>Retention before deletion<input className="field" defaultValue={settings?.default_retention_days ?? 30} max="3650" min="1" name="default_retention_days" required type="number" /></label>
          <label>Last directory sync<input className="field" disabled value={`${dateTime(settings?.last_sync_at)} · ${settings?.last_sync_status ?? "never"}`} /></label>
          <label className="checkbox-row"><input defaultChecked={settings?.directory_sync_enabled ?? false} name="directory_sync_enabled" type="checkbox" value="true" /> Enable scheduled directory sync</label>
          <label className="checkbox-row"><input defaultChecked={settings?.provisioning_enabled ?? false} name="provisioning_enabled" type="checkbox" value="true" /> Enable provisioning workers</label>
          <label className="checkbox-row"><input defaultChecked={settings?.automatic_suspension_enabled ?? true} name="automatic_suspension_enabled" type="checkbox" value="true" /> Suspend Google accounts on offboarding</label>
          {settings?.last_sync_error ? <div className="message-panel error" style={{ gridColumn: "1 / -1" }}>{settings.last_sync_error}</div> : null}
          <div className="form-actions" style={{ gridColumn: "1 / -1" }}><SubmitButton disabled={!permission?.canEdit}>Save connection master</SubmitButton></div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head toolbar">
          <div><h2>Designation identity policies</h2><p className="subtle">Each designation explicitly defines Gmail issuance, approval, groups, DropX portals, role and location scope.</p></div>
          <StatusPill status={`${policies.filter((row) => row.is_active).length} configured`} />
        </div>
        <div className="panel-body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
            {designations.map((designation) => {
              const configured = policies.some((row) => row.designation_id === designation.id && row.is_active);
              return <Link className={`button compact ${designation.id === selectedDesignationId ? "" : "secondary"}`} href={`${pagePath}?designation=${designation.id}`} key={designation.id}>{designation.code}{configured ? " ✓" : ""}</Link>;
            })}
          </div>
          {!selectedDesignation ? <div className="empty-cell">Create an active designation before configuring Workspace issuance.</div> : (
            <form action={saveDesignationWorkspacePolicy} className="form-grid three">
              <input name="designation_id" type="hidden" value={selectedDesignation.id} />
              <label>Designation<input className="field" disabled value={`${selectedDesignation.name} (${selectedDesignation.code})`} /></label>
              <label>Issuance approval<select className="field" defaultValue={policy?.approval_mode ?? "manual"} name="approval_mode"><option value="manual">Manual approval</option><option value="automatic">Automatic on active joining</option></select></label>
              <label>Email local-part pattern<input className="field" defaultValue={policy?.email_pattern ?? "{first}.{last}"} name="email_pattern" required /><small>{"Tokens: {first} {last} {employee_code} {designation_code} {location_code}"}</small></label>
              <label>Organisational unit<input className="field" defaultValue={policy?.org_unit_path ?? settings?.default_org_unit_path ?? "/"} name="org_unit_path" required /></label>
              <label>Managed Google Groups<textarea className="textarea" defaultValue={(policy?.group_emails ?? []).join("\n")} name="group_emails" placeholder="group@yourdomain.com" rows={3} /></label>
              <label>Central DropX role<select className="field" defaultValue={policy?.access_role_id ?? ""} name="access_role_id"><option value="">Gmail only — no DropX portal access</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} ({role.code})</option>)}</select></label>
              <label>Location scope<select className="field" defaultValue={policy?.location_access_mode ?? "assignment"} name="location_access_mode"><option value="assignment">Employee assigned location</option><option value="all_locations">All locations</option><option value="none">No location scope</option></select></label>
              <label>Retention override (days)<input className="field" defaultValue={policy?.retention_days ?? ""} max="3650" min="1" name="retention_days" placeholder={`Company default: ${settings?.default_retention_days ?? 30}`} type="number" /></label>
              <div style={{ gridColumn: "1 / -1" }}>
                <strong>DropX portal access</strong>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
                  {productDefinitions.map((product) => <label className="checkbox-row" key={product.code}><input defaultChecked={(policy?.product_codes ?? []).includes(product.code)} name="product_codes" type="checkbox" value={product.code} /> {product.name}</label>)}
                </div>
              </div>
              <label className="checkbox-row"><input defaultChecked={policy?.issue_workspace_account ?? false} name="issue_workspace_account" type="checkbox" value="true" /> Issue Google Workspace account</label>
              <label className="checkbox-row"><input defaultChecked={policy?.send_activation_email ?? true} name="send_activation_email" type="checkbox" value="true" /> Send credentials to personal email</label>
              <label className="checkbox-row"><input defaultChecked={policy?.is_active ?? true} name="is_active" type="checkbox" value="true" /> Policy active</label>
              <div className="form-actions" style={{ gridColumn: "1 / -1" }}><SubmitButton disabled={!permission?.canEdit}>Save designation policy</SubmitButton></div>
            </form>
          )}
        </div>
      </section>

      <GoogleWorkspaceDirectoryMapping
        accounts={directoryAccounts}
        canEdit={Boolean(permission?.canEdit)}
        employees={directoryEmployees}
        locations={directoryLocations}
      />

      <section className="panel" id="lifecycle-queue">
        <div className="panel-head"><div><h2>Lifecycle queue</h2><p className="subtle">Automatic retries are bounded. Manual policies and unresolved errors stay blocked for an administrator.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Created</th><th>Account</th><th>Action</th><th>Status</th><th>Attempts / error</th><th>Control</th></tr></thead><tbody>
          {jobs.map((job) => { const account = first(job.google_workspace_accounts); const manualApproval = job.status === "blocked" && job.job_type === "provision" && (!job.last_error || job.last_error.toLowerCase().includes("approval")); return <tr key={job.id}><td>{dateTime(job.created_at)}</td><td><strong>{account?.full_name ?? "Pending mapping"}</strong><small>{account?.primary_email ?? job.id.slice(0, 8)}</small></td><td>{job.job_type.replaceAll("_", " ")}</td><td><StatusPill status={job.status} /></td><td>{job.attempt_count}<small>{job.last_error ?? "—"}</small></td><td>{manualApproval ? <form action={approveWorkspaceJob}><input name="job_id" type="hidden" value={job.id} /><SubmitButton className="button compact" disabled={!permission?.canEdit}>Approve</SubmitButton></form> : ["failed", "blocked"].includes(job.status) ? <form action={retryWorkspaceJob}><input name="job_id" type="hidden" value={job.id} /><SubmitButton className="button secondary compact" disabled={!permission?.canEdit}>Retry</SubmitButton></form> : "—"}</td></tr>; })}
          {!jobs.length ? <tr><td className="empty-cell" colSpan={6}>No lifecycle jobs yet.</td></tr> : null}
        </tbody></table></div>
      </section>

      <section className="panel" id="deletion-queue">
        <div className="panel-head"><div><h2>Offboarding deletion queue</h2><p className="subtle">Suspension and DropX access revocation are immediate. Permanent deletion requires elapsed retention, completed data transfer, no legal hold and explicit approval.</p></div><StatusPill status={`${deletions.length} open`} /></div>
        <div className="table-wrap"><table><thead><tr><th>Account</th><th>Eligible after</th><th>Status</th><th>Safeguards</th><th>Review</th><th>Final action</th></tr></thead><tbody>
          {deletions.map((deletion) => { const account = first(deletion.google_workspace_accounts); const eligible = new Date(deletion.eligible_at).getTime() <= Date.now(); const canDelete = eligible && !deletion.legal_hold && ["completed", "not_required"].includes(deletion.data_transfer_status) && deletion.status !== "approved"; return <tr key={deletion.id}><td><strong>{account?.full_name ?? "Workspace account"}</strong><small>{account?.primary_email ?? deletion.account_id}</small></td><td>{dateTime(deletion.eligible_at)}</td><td><StatusPill status={deletion.status} /></td><td><StatusPill status={deletion.legal_hold ? "Legal hold" : "No hold"} /><small>Transfer: {deletion.data_transfer_status.replaceAll("_", " ")}</small></td><td><form action={updateWorkspaceDeletionReview} style={{ display: "grid", gap: 6, minWidth: 220 }}><input name="deletion_id" type="hidden" value={deletion.id} /><select className="field" defaultValue={deletion.data_transfer_status} name="data_transfer_status"><option value="pending">Transfer pending</option><option value="in_progress">Transfer in progress</option><option value="completed">Transfer completed</option><option value="not_required">Transfer not required</option></select><label className="checkbox-row"><input defaultChecked={deletion.legal_hold} name="legal_hold" type="checkbox" value="true" /> Legal hold</label><input className="field" defaultValue={deletion.note ?? ""} name="note" placeholder="Review note" /><SubmitButton className="button secondary compact" disabled={!permission?.canEdit}>Save review</SubmitButton></form></td><td><div style={{ display: "grid", gap: 6 }}><form action={approveWorkspaceDeletion}><input name="deletion_id" type="hidden" value={deletion.id} /><SubmitButton className="button danger compact" confirmationBlocked={!canDelete} confirmDescription="Google Workspace deletion cannot be undone." confirmMessage={`Permanently delete ${account?.primary_email ?? "this Workspace account"}? Retention and transfer safeguards must already be complete.`} confirmSubmitText="Approve permanent deletion" confirmTitle="Approve Workspace deletion" disabled={!permission?.canEdit || deletion.status === "approved"}>{deletion.status === "approved" ? "Queued" : "Approve delete"}</SubmitButton></form><form action={cancelWorkspaceDeletion}><input name="deletion_id" type="hidden" value={deletion.id} /><SubmitButton className="button secondary compact" confirmMessage="Cancel this deletion request? The Google account will remain suspended." confirmTitle="Cancel deletion" disabled={!permission?.canEdit}>Cancel</SubmitButton></form></div></td></tr>; })}
          {!deletions.length ? <tr><td className="empty-cell" colSpan={6}>No suspended Workspace accounts are awaiting deletion review.</td></tr> : null}
        </tbody></table></div>
      </section>
    </AppShell>
  );
}

const pagePath = "/settings/google-workspace";
