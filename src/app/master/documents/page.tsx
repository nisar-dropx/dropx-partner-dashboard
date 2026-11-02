
import { ReportTable } from "@/components/report-table";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { DocumentTypeForm, type DocumentRoleOption } from "@/components/document-type-form";
import { SearchableSelect } from "@/components/searchable-select";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createDocumentType, deleteDocumentType, updateDocumentComplianceManager, updateDocumentType } from "./actions";

type DocumentTypeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  document_module: string;
  business_scope_mode: string | null;
  doc_access_mode: string | null;
  access_role_ids: string[];
  enable_scope_access: boolean;
  requires_expiry: boolean;
  reminder_days: number;
  is_active: boolean;
  usage_count: number;
};

type UserOption = {
  id: string;
  name: string;
  employeeId: string | null;
  role: string | null;
  email: string | null;
};

function loadFlash() {
  const raw = cookies().get("dropx_document_master_flash")?.value;
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

function isMissingRoleAccessTable(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("document_type_role_access") &&
    (message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find"));
}

async function loadDocumentTypes(companyId: string) {
  if (!supabaseAdmin) {
    return {
      documents: [] as DocumentTypeRow[],
      roles: [] as DocumentRoleOption[],
      users: [] as UserOption[],
      settings: { compliance_manager_user_id: null as string | null, fleet_manager_user_id: null as string | null },
      settingsError: null as string | null,
      error: "Supabase service role key is not configured."
    };
  }

  const [typesResult, usageResult, businessUsageResult, usersResult, rolesResult, roleAccessResult, settingsResult] = await Promise.all([
    supabaseAdmin
      .from("document_types")
      .select("id, code, name, description, document_module, business_scope_mode, doc_access_mode, enable_scope_access, requires_expiry, reminder_days, is_active")
      .eq("company_id", companyId)
      .order("sort_order")
      .order("name"),
    supabaseAdmin
      .from("fleet_vehicle_documents")
      .select("document_type")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("business_document_records")
      .select("document_type_code")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("profiles")
      .select("id, employee_id, full_name, email, role_id, role")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("full_name"),
    supabaseAdmin
      .from("user_roles")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabaseAdmin
      .from("document_type_role_access")
      .select("document_type_id, role_id")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("business_document_settings")
      .select("compliance_manager_user_id, fleet_manager_user_id")
      .eq("company_id", companyId)
      .eq("id", true)
      .maybeSingle()
  ]);

  if (typesResult.error) return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: typesResult.error.message };
  if (usageResult.error && !usageResult.error.message.toLowerCase().includes("fleet_vehicle_documents")) {
    return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: usageResult.error.message };
  }
  if (businessUsageResult.error && !businessUsageResult.error.message.toLowerCase().includes("business_document_records")) {
    return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: businessUsageResult.error.message };
  }
  if (usersResult.error) {
    return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: usersResult.error.message };
  }
  if (rolesResult.error) {
    return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: rolesResult.error.message };
  }
  if (roleAccessResult.error && !isMissingRoleAccessTable(roleAccessResult.error)) {
    return { documents: [] as DocumentTypeRow[], roles: [] as DocumentRoleOption[], users: [] as UserOption[], settings: { compliance_manager_user_id: null, fleet_manager_user_id: null }, settingsError: null, error: `${roleAccessResult.error.message}. Run scripts/document_type_role_access_v1.sql in Supabase SQL Editor.` };
  }

  const usageByCode = new Map<string, number>();
  (usageResult.data ?? []).forEach((row) => {
    const code = String(row.document_type ?? "").toUpperCase();
    if (code) usageByCode.set(code, (usageByCode.get(code) ?? 0) + 1);
  });
  (businessUsageResult.data ?? []).forEach((row) => {
    const code = String(row.document_type_code ?? "").toUpperCase();
    if (code) usageByCode.set(code, (usageByCode.get(code) ?? 0) + 1);
  });
  const roleById = new Map((rolesResult.data ?? []).map((role) => [role.id, role]));
  const accessRolesByDocumentType = new Map<string, string[]>();
  (roleAccessResult.error ? [] : roleAccessResult.data ?? []).forEach((row) => {
    const documentTypeId = String(row.document_type_id ?? "");
    const roleId = String(row.role_id ?? "");
    if (!documentTypeId || !roleId) return;
    accessRolesByDocumentType.set(documentTypeId, [...accessRolesByDocumentType.get(documentTypeId) ?? [], roleId]);
  });
  const settingsError = settingsResult.error?.message ?? null;
  return {
    documents: ((typesResult.data ?? []) as Omit<DocumentTypeRow, "usage_count">[]).map((document) => ({
      ...document,
      code: document.code.toUpperCase(),
      access_role_ids: accessRolesByDocumentType.get(document.id) ?? [],
      usage_count: usageByCode.get(document.code.toUpperCase()) ?? 0
    })),
    roles: (rolesResult.data ?? []).map((role) => ({
      id: role.id,
      code: String(role.code ?? "").toUpperCase(),
      name: role.name || role.code || "Role"
    })),
    users: (usersResult.data ?? []).map((user) => ({
      id: user.id,
      name: user.full_name || user.email || "User",
      employeeId: user.employee_id,
      role: roleById.get(user.role_id)?.name || user.role || roleById.get(user.role_id)?.code || null,
      email: user.email
    })),
    settings: {
      compliance_manager_user_id: settingsResult.error ? null : settingsResult.data?.compliance_manager_user_id ?? null,
      fleet_manager_user_id: settingsResult.error ? null : settingsResult.data?.fleet_manager_user_id ?? null
    },
    settingsError,
    error: null
  };
}

function DocumentForm({
  action,
  initial,
  codeLocked = false,
  submitLabel = "Save document"
}: {
  action: (formData: FormData) => void;
  initial?: DocumentTypeRow;
  codeLocked?: boolean;
  submitLabel?: string;
}) {
  return (
    <form action={action} className="form-grid">
      {initial ? <input name="id" type="hidden" value={initial.id} /> : null}
      <label>
        Document code
        <input
          className="field"
          defaultValue={initial?.code.toUpperCase() ?? ""}
          name="code"
          placeholder="FLEET_INSURANCE"
          readOnly={codeLocked}
          required
          style={{ textTransform: "uppercase" }}
        />
      </label>
      <label>
        Document name
        <input className="field" defaultValue={initial?.name ?? ""} name="name" placeholder="Insurance" required />
      </label>
      <label>
        Document module
        <select className="field" defaultValue={initial?.document_module ?? "fleet"} name="document_module">
          <option value="fleet">Fleet Doc</option>
          <option value="business">Business Doc</option>
        </select>
      </label>
      <label>
        Scope type
        <select className="field" defaultValue={initial?.business_scope_mode ?? ""} disabled={initial?.document_module === "fleet"} name="business_scope_mode">
          <option value="">Select scope</option>
          <option value="company">Company</option>
          <option value="state">State</option>
          <option value="provider">Provider</option>
          <option value="location">Location</option>
        </select>
      </label>
      <label>
        Doc access
        <select className="field" defaultValue={initial?.doc_access_mode ?? "all_users"} name="doc_access_mode">
          <option value="all_users">All user access</option>
          <option value="role_based">Role based access</option>
        </select>
      </label>
      <label className="full-span">
        Description
        <input className="field" defaultValue={initial?.description ?? ""} name="description" placeholder="Policy copy and renewal tracking" />
      </label>
      <label>
        Reminder days
        <input className="field" defaultValue={String(initial?.reminder_days ?? 30)} min={0} max={365} name="reminder_days" type="number" />
      </label>
      <label>
        Status
        <select className="field" defaultValue={initial?.is_active === false ? "inactive" : "active"} name="status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </label>
      <label className="check-row business-expiry-check full-span">
        <input defaultChecked={initial?.requires_expiry ?? true} name="requires_expiry" type="checkbox" />
        <span>Track expiry date</span>
      </label>
      <div className="form-actions full-span">
        <SubmitButton pendingText="Saving">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

export const dynamic = "force-dynamic";

export default async function DocumentsPage({ searchParams }: { searchParams?: { add?: string; edit?: string; q?: string } }) {
  const authorization = await requirePagePermission("master_documents", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.master_documents;
  const { documents, roles, users, settings, settingsError, error } = await loadDocumentTypes(companyId);
  const flash = loadFlash();
  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const filteredDocuments = documents.filter((document) =>
    `${document.code} ${document.name} ${document.description ?? ""}`.toLowerCase().includes(query)
  );
  const editDocument = documents.find((document) => document.id === searchParams?.edit) ?? null;
  const complianceManagerOptions = users.map((user) => ({
    value: user.id,
    label: user.name,
    helper: [user.employeeId, user.role, user.email].filter(Boolean).join(" | ")
  }));
  const selectedComplianceManager = users.find((user) => user.id === settings.compliance_manager_user_id) ?? null;
  const selectedFleetManager = users.find((user) => user.id === settings.fleet_manager_user_id) ?? null;

  return (
    <AppShell active="Documents" pageCode="master_documents">
      <PageHead
        eyebrow="Master Data"
        title="Documents"
        subtitle="Maintain reusable document templates for fleet uploads and business compliance records."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/document_types_v1.sql` in Supabase SQL Editor, then refresh this page.
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
              <h2>Document managers</h2>
              <p className="subtle">Common managers used for business and fleet document workflows.</p>
            </div>
            <form action={updateDocumentComplianceManager} className="business-doc-manager-form">
              <label>
                Compliance manager
                <SearchableSelect
                  name="compliance_manager_user_id"
                  options={complianceManagerOptions}
                  defaultValue={settings.compliance_manager_user_id}
                  placeholder="Search name, emp id, role"
                  disabled={!pagePermission.canEdit}
                />
              </label>
              <label>
                Fleet manager
                <SearchableSelect
                  name="fleet_manager_user_id"
                  options={complianceManagerOptions}
                  defaultValue={settings.fleet_manager_user_id}
                  placeholder="Search name, emp id, role"
                  disabled={!pagePermission.canEdit}
                />
              </label>
              {pagePermission.canEdit ? <SubmitButton className="button secondary compact" pendingText="Saving">Save</SubmitButton> : null}
            </form>
          </div>
          {settingsError ? (
            <div className="panel-body compact-warning">
              <strong>Manager setup needed</strong>
              <span>{settingsError} Run `scripts/business_document_settings_v1.sql` in Supabase SQL Editor.</span>
            </div>
          ) : selectedComplianceManager || selectedFleetManager ? (
            <div className="business-doc-manager-summary">
              {selectedComplianceManager ? (
                <>
                  <span>Compliance manager</span>
                  <strong>{selectedComplianceManager.name}</strong>
                  <small>{[selectedComplianceManager.employeeId, selectedComplianceManager.role, selectedComplianceManager.email].filter(Boolean).join(" | ")}</small>
                </>
              ) : null}
              {selectedFleetManager ? (
                <>
                  <span>Fleet manager</span>
                  <strong>{selectedFleetManager.name}</strong>
                  <small>{[selectedFleetManager.employeeId, selectedFleetManager.role, selectedFleetManager.email].filter(Boolean).join(" | ")}</small>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Document list</h2>
              <p className="subtle">{filteredDocuments.length} of {documents.length} records</p>
            </div>
            <div className="master-toolbar">
              <form className="inline-search" action="/master/documents">
                <input className="field" defaultValue={searchParams?.q ?? ""} name="q" placeholder="Search document" />
                <button className="button secondary compact" type="submit">Search</button>
                {query ? <PendingLink className="button secondary compact" href="/master/documents">Clear</PendingLink> : null}
              </form>
              {pagePermission.canAdd ? <PendingLink className="button compact" href="/master/documents?add=1" scroll={false}>Add document</PendingLink> : null}
            </div>
          </div>
          <div className="table-wrap">
            <ReportTable>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Document</th>
                  <th>Module</th>
                  <th>Scope</th>
                  <th>Access</th>
                  <th>Scope access</th>
                  <th>Expiry</th>
                  <th>Reminder</th>
                  <th>Used</th>
                  <th>Status</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.length ? filteredDocuments.map((document) => (
                  <tr key={document.id}>
                    <td><strong>{document.code.toUpperCase()}</strong></td>
                    <td>
                      {document.name}
                      {document.description ? <div className="subtle">{document.description}</div> : null}
                    </td>
                    <td>{document.document_module === "business" ? "Business" : "Fleet"}</td>
                    <td>{document.document_module === "business" ? scopeModeLabel(document.business_scope_mode) : "-"}</td>
                    <td>{docAccessLabel(document.doc_access_mode, document.access_role_ids, roles)}</td>
                    <td>{document.document_module === "business" && document.enable_scope_access ? "Enabled" : "-"}</td>
                    <td>{document.requires_expiry ? "Tracked" : "Not required"}</td>
                    <td>{document.requires_expiry ? `${document.reminder_days} days` : "-"}</td>
                    <td>{document.usage_count}</td>
                    <td><StatusPill status={document.is_active ? "Active" : "Inactive"} /></td>
                    {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/documents?edit=${document.id}`} scroll={false}>Edit</PendingLink></td> : null}
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 11 : 10}>No documents found.</td></tr>
                )}
              </tbody>
            </ReportTable>
          </div>
        </section>
      ) : null}

      {!error && searchParams?.add === "1" && pagePermission.canAdd ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Add document</h2>
                <p className="subtle">Create a reusable template for fleet or business document tracking.</p>
              </div>
              <PendingLink className="icon-button" href="/master/documents" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DocumentTypeForm action={createDocumentType} roleOptions={roles} />
          </section>
        </div>
      ) : null}

      {!error && editDocument && pagePermission.canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Edit document</h2>
                <p className="subtle">Existing uploads keep their document code while labels, reminders, and scope rules can change.</p>
              </div>
              <PendingLink className="icon-button" href="/master/documents" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DocumentTypeForm
              action={updateDocumentType}
              codeLocked={editDocument.usage_count > 0}
              initial={editDocument}
              roleOptions={roles}
              submitLabel="Save changes"
            />
            <form action={deleteDocumentType} className="danger-form">
              <input name="id" type="hidden" value={editDocument.id} />
              <input name="code" type="hidden" value={editDocument.code} />
              <SubmitButton
                className="button warning"
                disabled={editDocument.usage_count > 0}
                disabledText="Delete locked"
                confirmMessage="Delete this document type?"
                confirmSubmitText="Delete"
                pendingText="Deleting"
              >
                Delete document
              </SubmitButton>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}

function scopeModeLabel(value: string | null) {
  const labels: Record<string, string> = {
    company: "Company",
    state: "State",
    location: "Location",
    provider: "Provider"
  };
  return value ? labels[value] ?? value : "-";
}

function docAccessLabel(value: string | null, roleIds: string[], roles: DocumentRoleOption[]) {
  if (value !== "role_based") return "All users";
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const names = roleIds.map((id) => roleById.get(id)?.name).filter(Boolean);
  return names.length ? `Role based: ${names.join(", ")}` : "Role based";
}
