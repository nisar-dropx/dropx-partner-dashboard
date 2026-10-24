import { businessDocumentWorkspace } from "@/lib/business-document-workspace";
import { documentInWorkspace } from "@/lib/business-document-workspace-policy";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { BusinessDocumentForm } from "@/components/business-document-form";
import { BusinessDocumentFilters } from "@/components/business-document-filters";
import { BusinessDocumentsTable } from "@/components/business-documents-table";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createBusinessDocument, deleteBusinessDocument, updateBusinessDocument } from "./actions";

type DocumentTypeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requires_expiry: boolean;
  business_scope_mode: string | null;
  doc_access_mode: string | null;
  access_role_ids: string[];
  enable_scope_access: boolean;
};

type BusinessDocumentRow = {
  id: string;
  document_type_id: string;
  document_type_code: string;
  scope_type: string;
  scope_id: string | null;
  scope_label: string;
  additional_scope_ids: string[] | null;
  reference_no: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  track_expiry: boolean | null;
  file_name: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  status: string;
  uploaded_at: string;
  signed_url?: string | null;
  document_types?: { name: string; description: string | null; requires_expiry: boolean; doc_access_mode: string | null; access_role_ids?: string[] } | null;
};

type OptionRow = {
  id: string;
  code: string;
  name: string;
  location_model_id?: string | null;
  provider_id?: string | null;
  state?: string | null;
};

type UserOption = {
  id: string;
  name: string;
  employeeId: string | null;
  role: string | null;
  email: string | null;
};

const pageSize = 20;

function loadFlash() {
  const raw = cookies().get("dropx_business_documents_flash")?.value;
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

async function loadBusinessDocuments(companyId: string, authorization: Awaited<ReturnType<typeof requirePagePermission>>) {
  if (!supabaseAdmin) {
    return {
      documents: [] as BusinessDocumentRow[],
      documentTypes: [] as DocumentTypeRow[],
      locations: [] as OptionRow[],
      models: [] as OptionRow[],
      providers: [] as OptionRow[],
      states: [] as OptionRow[],
      users: [] as UserOption[],
      settings: { compliance_manager_user_id: null as string | null },
      settingsError: null as string | null,
      error: "Supabase service role key is not configured."
    };
  }

  const [typesResult, recordsResult, locationsResult, providersResult, modelsResult, usersResult, rolesResult, roleAccessResult, settingsResult] = await Promise.all([
    supabaseAdmin
      .from("document_types")
      .select("id, code, name, description, requires_expiry, business_scope_mode, doc_access_mode, enable_scope_access")
      .eq("company_id", companyId)
      .eq("document_module", "business")
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    supabaseAdmin
      .from("business_document_records")
      .select(`
        id,
        document_type_id,
        document_type_code,
        scope_type,
        scope_id,
        scope_label,
        additional_scope_ids,
        reference_no,
        issue_date,
        expiry_date,
        track_expiry,
        file_name,
        storage_bucket,
        storage_path,
        status,
        uploaded_at,
        document_types (name, description, requires_expiry, doc_access_mode)
      `)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("uploaded_at", { ascending: false }),
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, state, provider_id, location_model_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code"),
    supabaseAdmin
      .from("providers")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
    supabaseAdmin
      .from("location_models")
      .select("id, code, name, provider_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
    supabaseAdmin
      .from("profiles")
      .select("id, employee_id, full_name, email, role_id, role")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("full_name"),
    supabaseAdmin
      .from("user_roles")
      .select("id, code, name")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("document_type_role_access")
      .select("document_type_id, role_id")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("business_document_settings")
      .select("compliance_manager_user_id")
      .eq("company_id", companyId)
      .eq("id", true)
      .maybeSingle()
  ]);

  const error = typesResult.error?.message ||
    recordsResult.error?.message ||
    locationsResult.error?.message ||
    providersResult.error?.message ||
    modelsResult.error?.message ||
    usersResult.error?.message ||
    rolesResult.error?.message ||
    (roleAccessResult.error && !isMissingRoleAccessTable(roleAccessResult.error) ? roleAccessResult.error.message : null) ||
    null;
  if (error) {
    return { documents: [], documentTypes: [], locations: [], models: [], providers: [], states: [], users: [], settings: { compliance_manager_user_id: null }, settingsError: null, error };
  }

  const workspace = await businessDocumentWorkspace(authorization);
  const workspaceIds = workspace === null ? null : new Set(workspace.map(row => row.id));
  const scopedOptions = (locationsResult.data ?? []).filter(row => workspaceIds ? workspaceIds.has(row.id) : authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.locationScopeIds.includes(row.id));
  const allowedLocationIds = new Set(authorization.locationScopeIds);
  const allowedStates = new Set(
    (locationsResult.data ?? [])
      .filter((location) => allowedLocationIds.has(location.id))
      .map((location) => String(location.state ?? "").trim().toUpperCase())
      .filter(Boolean)
  );
  const canSeeAllScopedDocs = authorization.hasAllLocationAccess || authorization.isMasterOwner;
  const accessRolesByDocumentType = new Map<string, string[]>();
  (roleAccessResult.error ? [] : roleAccessResult.data ?? []).forEach((row) => {
    const documentTypeId = String(row.document_type_id ?? "");
    const roleId = String(row.role_id ?? "");
    if (!documentTypeId || !roleId) return;
    accessRolesByDocumentType.set(documentTypeId, [...accessRolesByDocumentType.get(documentTypeId) ?? [], roleId]);
  });
  const visibleRows = ((recordsResult.data ?? []) as unknown as Array<Omit<BusinessDocumentRow, "document_types"> & {
    document_types?: BusinessDocumentRow["document_types"] | BusinessDocumentRow["document_types"][];
  }>)
    .map((row) => ({
      ...row,
      document_types: withAccessRoleIds(firstRelation(row.document_types), accessRolesByDocumentType.get(row.document_type_id) ?? [])
    }))
    .filter((row) => canViewBusinessDocument(row, allowedLocationIds, allowedStates, canSeeAllScopedDocs, authorization.roleId))
    .filter(row => workspace === null || documentInWorkspace(row, workspace));

  const stateByCode = new Map<string, OptionRow>();
  scopedOptions.forEach((row) => {
    const code = String(row.state ?? "").trim().toUpperCase();
    if (code && !stateByCode.has(code)) stateByCode.set(code, { id: code, code, name: code });
  });

  const roleById = new Map((rolesResult.data ?? []).map((role) => [role.id, role]));
  const settingsError = settingsResult.error?.message ?? null;

  return {
    documents: visibleRows.map((row) => ({ ...row, signed_url: null })),
    documentTypes: ((typesResult.data ?? []) as Omit<DocumentTypeRow, "access_role_ids">[]).map((documentType) => ({
      ...documentType,
      access_role_ids: accessRolesByDocumentType.get(documentType.id) ?? []
    })),
    locations: scopedOptions.map((row) => ({
      id: row.id,
      code: row.station_code,
      name: row.station_name && row.station_name !== row.station_code ? row.station_name : row.station_code,
      location_model_id: row.location_model_id,
      provider_id: row.provider_id,
      state: row.state
    })),
    models: (modelsResult.data ?? []).filter(row => scopedOptions.some(location => location.location_model_id === row.id)).map((row) => ({ id: row.id, code: row.code, name: row.name, provider_id: row.provider_id })),
    providers: (providersResult.data ?? []).filter(row => scopedOptions.some(location => location.provider_id === row.id)).map((row) => ({ id: row.id, code: row.code, name: row.name })),
    states: Array.from(stateByCode.values()).sort((a, b) => a.code.localeCompare(b.code)),
    users: (usersResult.data ?? []).map((user) => ({
      id: user.id,
      name: user.full_name || user.email || "User",
      employeeId: user.employee_id,
      role: roleById.get(user.role_id)?.name || user.role || roleById.get(user.role_id)?.code || null,
      email: user.email
    })),
    settings: {
      compliance_manager_user_id: settingsResult.error ? null : settingsResult.data?.compliance_manager_user_id ?? null
    },
    settingsError,
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function BusinessDocumentsPage({ searchParams }: { searchParams?: { add?: string; edit?: string; q?: string; state?: string; location?: string; document?: string; provider?: string; model?: string; expiry?: string; page?: string } }) {
  const authorization = await requirePagePermission("business_documents", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.business_documents;
  const { documents, documentTypes, locations, models, providers, states, users, settings, settingsError, error } = await loadBusinessDocuments(companyId, authorization);
  const flash = loadFlash();
  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const stateFilters = parseFilterValues(searchParams?.state).map((value) => value.toUpperCase());
  const locationFilters = parseFilterValues(searchParams?.location);
  const documentFilters = parseFilterValues(searchParams?.document);
  const providerFilters = parseFilterValues(searchParams?.provider);
  const modelFilters = parseFilterValues(searchParams?.model);
  const expiryFilters = parseFilterValues(searchParams?.expiry);
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const selectedComplianceManager = users.find((user) => user.id === settings.compliance_manager_user_id) ?? null;
  const baseFilteredDocuments = documents.filter((document) => {
    const textMatches = !query || `${document.document_type_code} ${document.document_types?.name ?? ""} ${document.scope_label} ${document.reference_no ?? ""}`
      .toLowerCase()
      .includes(query);
    const documentMatches = !documentFilters.length || documentFilters.includes(document.document_type_id);
    const locationMatches = !locationFilters.length || (document.scope_type === "location" && Boolean(document.scope_id && locationFilters.includes(document.scope_id)));
    const additionalScopes = document.additional_scope_ids ?? [];
    const locationAccessMatches = !locationFilters.length || (document.scope_type === "location" && additionalScopes.some((id) => locationFilters.includes(id)));
    const stateMatches = !stateFilters.length || stateFilters.includes(documentStateCode(document, locationById)) || (document.scope_type === "state" && additionalScopes.some((id) => stateFilters.includes(id.toUpperCase())));
    const providerMatches = documentMatchesProvider(document, locationById, providerFilters);
    const modelMatches = documentMatchesModel(document, locationById, modelFilters);
    return textMatches && documentMatches && (locationMatches || locationAccessMatches) && stateMatches && providerMatches && modelMatches;
  });
  const filteredDocuments = baseFilteredDocuments.filter((document) => {
    const expiryMatches = !expiryFilters.length || expiryFilters.includes(expiryBucket(document.expiry_date));
    return expiryMatches;
  });
  const requestedPage = Number(searchParams?.page ?? "1");
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const totalPages = Math.max(1, Math.ceil(filteredDocuments.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedDocuments = filteredDocuments.slice((safePage - 1) * pageSize, safePage * pageSize);
  const visibleDocuments = await attachSignedUrls(pagedDocuments);
  const visibleDocumentRows = visibleDocuments.map((document) => ({
    id: document.id,
    documentName: document.document_types?.name ?? document.document_type_code,
    scope: scopeCode(document),
    reference: document.reference_no ?? "-",
    issue: formatDate(document.issue_date),
    expiry: formatDate(document.expiry_date),
    expiryClassName: expiryClassName(document.expiry_date),
    status: statusLabel(document),
    days: daysLabel(document.expiry_date),
    signedUrl: document.signed_url ?? null,
    fileName: document.file_name,
    canDownload: Boolean(document.storage_bucket && document.storage_path),
    manageUrl: `/business-documents?edit=${document.id}`
  }));
  const filteredDownloadableIds = filteredDocuments
    .filter((document) => document.storage_bucket && document.storage_path)
    .map((document) => document.id);
  const expirySummary = expirySummaryCounts(baseFilteredDocuments);
  const editDocument = documents.find((document) => document.id === searchParams?.edit) ?? null;

  return (
    <AppShell active="Business Docs" pageCode="business_documents">
      <PageHead
        eyebrow="Compliance"
        title="Business Documents"
        subtitle="Track GST, PAN, trade licenses, and other business records by company, state, provider, or location."
        action={(
          <div className="business-doc-page-head-actions">
            {selectedComplianceManager ? (
              <div className="business-doc-manager-inline">
                <span>Compliance manager</span>
                <strong>{selectedComplianceManager.name}</strong>
                {selectedComplianceManager.email ? <small>{selectedComplianceManager.email}</small> : null}
              </div>
            ) : null}
            <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>
          </div>
        )}
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

      {!error && !documentTypes.length ? (
        <section className="panel message-panel warn">
          <div className="panel-body">
            <strong>No business document templates</strong>
            <p className="subtle" style={{ marginTop: 6 }}>Add Business Doc types in Master Data &gt; Documents, then create records here.</p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Business document records</h2>
              <p className="subtle">{filteredDocuments.length} of {documents.length} records</p>
            </div>
            <div className="master-toolbar">
              <BusinessDocumentFilters
                documentOptions={documentTypes.map((document) => ({ value: document.id, label: document.name }))}
                locationOptions={locations.map((location) => ({ value: location.id, label: location.code }))}
                modelOptions={models.map((model) => ({ value: model.id, label: `${model.code} - ${model.name}` }))}
                providerOptions={providers.map((provider) => ({ value: provider.id, label: `${provider.code} - ${provider.name}` }))}
                stateOptions={states.map((state) => ({ value: state.code, label: state.code }))}
              />
              {pagePermission.canAdd ? <PendingLink className="button compact" href="/business-documents?add=1" scroll={false}>Add document</PendingLink> : null}
            </div>
          </div>
          {settingsError ? (
            <div className="panel-body compact-warning">
              <strong>Manager setup needed</strong>
              <span>{settingsError} Run `scripts/business_document_settings_v1.sql` in Supabase SQL Editor.</span>
            </div>
          ) : null}
          <div className="fleet-date-summary business-doc-expiry-summary">
            <SummaryCard active={!expiryFilters.length} href={businessDocumentsHref(searchParams, { expiry: "" })} label="All" value={expirySummary.all} tone="business-all" />
            <SummaryCard active={expiryFilters.includes("valid")} href={businessDocumentsHref(searchParams, { expiry: "valid" })} label="Active" value={expirySummary.active} tone="business-active" />
            <SummaryCard active={expiryFilters.includes("15-30")} href={businessDocumentsHref(searchParams, { expiry: "15-30" })} label="Expires in 15-30 D" value={expirySummary.due30} tone="business-yellow" />
            <SummaryCard active={expiryFilters.includes("7-15")} href={businessDocumentsHref(searchParams, { expiry: "7-15" })} label="Expires in 7-15 D" value={expirySummary.due15} tone="business-light-orange" />
            <SummaryCard active={expiryFilters.includes("0-7")} href={businessDocumentsHref(searchParams, { expiry: "0-7" })} label="Expires in 0-7 D" value={expirySummary.due7} tone="business-dark-orange" />
            <SummaryCard active={expiryFilters.includes("expired")} href={businessDocumentsHref(searchParams, { expiry: "expired" })} label="Expired" value={expirySummary.expired} tone="business-red" />
          </div>
          <BusinessDocumentsTable
            allFilteredIds={filteredDownloadableIds}
            canEdit={Boolean(pagePermission.canEdit)}
            rows={visibleDocumentRows}
          />
          {filteredDocuments.length > pageSize ? (
            <div className="panel-foot pagination">
              <span>Page {safePage} of {totalPages}</span>
              <PendingLink className="pager-button" href={businessDocumentsHref(searchParams, { page: String(Math.max(1, safePage - 1)) })} scroll={false}>Prev</PendingLink>
              <PendingLink className="pager-button" href={businessDocumentsHref(searchParams, { page: String(Math.min(totalPages, safePage + 1)) })} scroll={false}>Next</PendingLink>
            </div>
          ) : null}
        </section>
      ) : null}

      {!error && searchParams?.add === "1" && pagePermission.canAdd ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Add business document</h2>
                <p className="subtle">Create one compliance record using the scope configured in Document Master.</p>
              </div>
              <PendingLink className="icon-button" href="/business-documents" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <BusinessDocumentForm action={createBusinessDocument} documentTypes={documentTypes} locations={locations} providers={providers} states={states} />
          </section>
        </div>
      ) : null}

      {!error && editDocument && pagePermission.canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Manage business document</h2>
                <p className="subtle">Update the reference, expiry, or upload a replacement file.</p>
              </div>
              <PendingLink className="icon-button" href="/business-documents" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <BusinessDocumentForm
              action={updateBusinessDocument}
              documentTypes={documentTypes}
              initial={editDocument}
              locations={locations}
              providers={providers}
              states={states}
              submitLabel="Save changes"
            />
            <form action={deleteBusinessDocument} className="danger-form">
              <input name="id" type="hidden" value={editDocument.id} />
              <SubmitButton
                className="button warning"
                confirmMessage="Remove this business document record?"
                confirmSubmitText="Remove"
                pendingText="Removing"
              >
                Remove record
              </SubmitButton>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}

function statusLabel(document: BusinessDocumentRow) {
  if (!document.file_name) return "Pending";
  if (!document.expiry_date) return "Active";
  const expiry = new Date(`${document.expiry_date}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return "Active";
  return expiry.getTime() < startOfDay(new Date()).getTime() ? "Expired" : "Active";
}

function SummaryCard({ active, href, label, value, tone }: { active?: boolean; href: string; label: string; value: number; tone: string }) {
  const className = `fleet-date-summary-card ${tone}${active ? " selected" : ""}`;
  const content = (
    <>
      <span>{label}</span>
      <b>{value}</b>
    </>
  );
  if (active) return <div className={className}>{content}</div>;
  return <PendingLink className={className} href={href} scroll={false}>{content}</PendingLink>;
}

function expirySummaryCounts(documents: BusinessDocumentRow[]) {
  return documents.reduce((counts, document) => {
    counts.all += 1;
    const days = daysUntil(document.expiry_date);
    if (days === null || days > 30) counts.active += 1;
    else if (days < 0) counts.expired += 1;
    else if (days <= 7) counts.due7 += 1;
    else if (days <= 15) counts.due15 += 1;
    else if (days <= 30) counts.due30 += 1;
    return counts;
  }, { all: 0, active: 0, expired: 0, due7: 0, due15: 0, due30: 0 });
}

async function attachSignedUrls(documents: BusinessDocumentRow[]) {
  return documents.map((document) => {
    if (!document.storage_path || !document.storage_bucket) return { ...document, signed_url: null };
    return { ...document, signed_url: `/api/business-documents/download?id=${encodeURIComponent(document.id)}&disposition=inline` };
  });
}

function scopeCode(document: BusinessDocumentRow) {
  if (document.scope_type === "company") return "COMPANY";
  if (document.scope_type === "state") return String(document.scope_id ?? document.scope_label).trim().toUpperCase();
  return String(document.scope_label || document.scope_id || "-").split(" - ")[0].trim();
}

function documentStateCode(document: BusinessDocumentRow, locationById: Map<string, OptionRow>) {
  if (document.scope_type === "state") return String(document.scope_id ?? document.scope_label).trim().toUpperCase();
  if (document.scope_type === "location" && document.scope_id) {
    return String(locationById.get(document.scope_id)?.state ?? "").trim().toUpperCase();
  }
  return "";
}

function documentLocationIds(document: BusinessDocumentRow) {
  if (document.scope_type !== "location") return [];
  return [document.scope_id, ...document.additional_scope_ids ?? []].filter(Boolean) as string[];
}

function documentMatchesProvider(document: BusinessDocumentRow, locationById: Map<string, OptionRow>, providerFilters: string[]) {
  if (!providerFilters.length) return true;
  const selected = new Set(providerFilters);
  if (document.scope_type === "provider") {
    return Boolean(
      (document.scope_id && selected.has(document.scope_id)) ||
      (document.additional_scope_ids ?? []).some((id) => selected.has(id))
    );
  }
  return documentLocationIds(document).some((locationId) => {
    const location = locationById.get(locationId);
    return Boolean(location?.provider_id && selected.has(location.provider_id));
  });
}

function documentMatchesModel(document: BusinessDocumentRow, locationById: Map<string, OptionRow>, modelFilters: string[]) {
  if (!modelFilters.length) return true;
  const selected = new Set(modelFilters);
  return documentLocationIds(document).some((locationId) => {
    const location = locationById.get(locationId);
    return Boolean(location?.location_model_id && selected.has(location.location_model_id));
  });
}

function expiryClassName(value: string | null | undefined) {
  const days = daysUntil(value);
  if (days === null) return "";
  if (days <= 0) return "expiry-chip expiry-red";
  if (days <= 7) return "expiry-chip expiry-dark-orange";
  if (days <= 15) return "expiry-chip expiry-light-orange";
  if (days <= 30) return "expiry-chip expiry-yellow";
  return "";
}

function daysLabel(value: string | null | undefined) {
  const days = daysUntil(value);
  if (days === null) return "-";
  if (days < 0) return `${Math.abs(days)}d expired`;
  if (days === 0) return "Today";
  return `${days}d left`;
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const expiry = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return null;
  const diff = expiry.getTime() - startOfDay(new Date()).getTime();
  return Math.ceil(diff / 86400000);
}

function formatDate(value: string | null | undefined) {
  return formatDashboardDate(value);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function withAccessRoleIds<T extends { access_role_ids?: string[] } | null>(value: T, accessRoleIds: string[]) {
  if (!value) return value;
  return { ...value, access_role_ids: accessRoleIds };
}

function businessDocumentsHref(
  current: { q?: string; state?: string; location?: string; document?: string; provider?: string; model?: string; expiry?: string; page?: string } | undefined,
  next: { page?: string; expiry?: string }
) {
  const params = new URLSearchParams();
  if (current?.q) params.set("q", current.q);
  if (current?.state) params.set("state", current.state);
  if (current?.location) params.set("location", current.location);
  if (current?.document) params.set("document", current.document);
  if (current?.provider) params.set("provider", current.provider);
  if (current?.model) params.set("model", current.model);
  if (current?.expiry) params.set("expiry", current.expiry);
  if (next.expiry !== undefined) {
    if (next.expiry) params.set("expiry", next.expiry);
    else params.delete("expiry");
  }
  if (next.page && next.page !== "1") params.set("page", next.page);
  else params.delete("page");
  const query = params.toString();
  return `/business-documents${query ? `?${query}` : ""}`;
}

function parseFilterValues(value: string | undefined) {
  return Array.from(new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

function expiryBucket(value: string | null | undefined) {
  const days = daysUntil(value);
  if (days === null || days > 30) return "valid";
  if (days < 0) return "expired";
  if (days <= 7) return "0-7";
  if (days <= 15) return "7-15";
  return "15-30";
}

function canViewBusinessDocument(
  document: Omit<BusinessDocumentRow, "signed_url">,
  allowedLocationIds: Set<string>,
  allowedStates: Set<string>,
  canSeeAllScopedDocs: boolean,
  roleId: string | null
) {
  if (canSeeAllScopedDocs) return true;
  if (document.document_types?.doc_access_mode === "role_based") {
    const allowedRoleIds = document.document_types?.access_role_ids ?? [];
    if (allowedRoleIds.length && (!roleId || !allowedRoleIds.includes(roleId))) return false;
  }

  if (document.scope_type === "location") {
    return Boolean(
      (document.scope_id && allowedLocationIds.has(document.scope_id)) ||
      (document.additional_scope_ids ?? []).some((id) => allowedLocationIds.has(id))
    );
  }

  if (document.scope_type === "state") {
    return Boolean(
      (document.scope_id && allowedStates.has(String(document.scope_id).trim().toUpperCase())) ||
      (document.additional_scope_ids ?? []).some((id) => allowedStates.has(String(id).trim().toUpperCase()))
    );
  }

  return document.scope_type === "company";
}
