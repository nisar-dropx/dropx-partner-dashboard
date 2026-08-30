import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { DesignationForm } from "@/components/designation-form";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { firstDesignationBusinessCategory, type DesignationBusinessCategory } from "@/lib/designation-business-categories";
import { designationCategoryLabel, normalizeDesignationCategories } from "@/lib/designation-categories";
import { designationProfileDestinationLabel, inferDesignationProfileDestination, type DesignationProfileDestination } from "@/lib/designation-profile-destination";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createDesignation, deleteDesignation, updateDesignation } from "./actions";

type ProviderRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type ModelRow = {
  id: string;
  provider_id: string | null;
  code: string;
  name: string;
  is_active: boolean;
  providers?: { code: string; name: string } | { code: string; name: string }[] | null;
};

type DesignationRow = {
  id: string;
  code: string;
  name: string;
  designation_category_id?: string | null;
  designation_category?: DesignationBusinessCategory | DesignationBusinessCategory[] | null;
  profile_destination?: DesignationProfileDestination | null;
  registration_category_code?: string | null;
  provider_ids: string[];
  location_ids?: string[];
  model_ids?: string[] | null;
  onboarding_categories: string[];
  app_page_access?: string[] | null;
  onboarding_role_ids?: string[] | null;
  portal_permissions?: unknown;
  profile_field_rules?: unknown;
  is_field_operations?: boolean | null;
  is_active: boolean;
};

type UserRoleRow = { id: string; code: string; name: string; is_active: boolean };

type WorkforceCategoryRow = {
  code: string;
  name: string;
  is_active: boolean;
  profile_field_rules?: unknown;
  app_page_access?: string[] | null;
};

function loadFlash() {
  const raw = cookies().get("dropx_designation_flash")?.value;
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

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

async function loadDesignations(companyId: string) {
  if (!supabaseAdmin) {
    return {
      designations: [] as DesignationRow[],
      providers: [] as ProviderRow[],
      models: [] as ModelRow[],
      categories: [] as WorkforceCategoryRow[],
      businessCategories: [] as DesignationBusinessCategory[],
      roles: [] as UserRoleRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const [designationsResult, providersResult, modelsResult, categoriesResult, businessCategoriesResult, rolesResult] = await Promise.all([
    supabaseAdmin.from("designations").select("id, code, name, designation_category_id, designation_category:designation_categories!designations_designation_category_id_fkey!inner(id, code, name, people_module, is_active), profile_destination, registration_category_code, provider_ids, model_ids, location_ids, onboarding_categories, profile_field_rules, app_page_access, onboarding_role_ids, portal_permissions, is_field_operations, is_active").eq("company_id", companyId).eq("designation_category.people_module", "people_hr").eq("designation_category.is_active", true).order("code"),
    supabaseAdmin.from("providers").select("id, code, name, is_active").eq("company_id", companyId).order("code"),
    supabaseAdmin.from("location_models").select("id, provider_id, code, name, is_active, providers (code, name)").eq("company_id", companyId).eq("is_active", true).order("code"),
    supabaseAdmin.from("workforce_categories").select("code, name, is_active, profile_field_rules, app_page_access").eq("company_id", companyId).eq("is_active", true).order("sort_order").order("name"),
    supabaseAdmin.from("designation_categories").select("id, code, name, people_module, is_active").eq("company_id", companyId).eq("people_module", "people_hr").eq("is_active", true).order("sort_order").order("name"),
    supabaseAdmin.from("user_roles").select("id, code, name, is_active").eq("company_id", companyId).eq("is_active", true).order("name")
  ]);
  if (designationsResult.error) {
    return {
      designations: [] as DesignationRow[],
      providers: [] as ProviderRow[],
      models: [] as ModelRow[],
      categories: [] as WorkforceCategoryRow[],
      businessCategories: [] as DesignationBusinessCategory[],
      roles: [] as UserRoleRow[],
      error: designationsResult.error.message
    };
  }
  const setupError = providersResult.error || modelsResult.error || businessCategoriesResult.error;
  if (setupError) {
    return {
      designations: [] as DesignationRow[],
      providers: [] as ProviderRow[],
      models: [] as ModelRow[],
      categories: [] as WorkforceCategoryRow[],
      businessCategories: [] as DesignationBusinessCategory[],
      roles: [] as UserRoleRow[],
      error: setupError.message
    };
  }
  const fallbackCategories: WorkforceCategoryRow[] = [
    { code: "employees", name: "Employees", is_active: true },
    { code: "field_executives", name: "Field Executives", is_active: true },
    { code: "contractors", name: "Independent Contractor", is_active: true },
    { code: "vendors", name: "Vendors", is_active: true },
    { code: "workers", name: "Workers", is_active: true }
  ];

  return {
    designations: ((designationsResult.data ?? []) as DesignationRow[]).map((designation) => {
      const businessCategory = firstDesignationBusinessCategory(designation.designation_category);
      const onboardingCategories = normalizeDesignationCategories(designation.onboarding_categories);
      return {
        ...designation,
        onboarding_categories: onboardingCategories,
        profile_destination: inferDesignationProfileDestination({ onboardingCategories, peopleModule: businessCategory?.people_module ?? null, profileDestination: designation.profile_destination })
      };
    }),
    providers: (providersResult.data ?? []) as ProviderRow[],
    models: (modelsResult.data ?? []) as ModelRow[],
    categories: categoriesResult.error ? fallbackCategories : (categoriesResult.data ?? []) as WorkforceCategoryRow[],
    businessCategories: (businessCategoriesResult.data ?? []) as DesignationBusinessCategory[],
    roles: rolesResult.error ? [] : (rolesResult.data ?? []) as UserRoleRow[],
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function DesignationsPage({
  searchParams
}: {
  searchParams?: { add?: string; edit?: string; q?: string };
}) {
  const authorization = await requirePagePermission("designations", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.designations;
  const { designations, providers, models, categories, businessCategories, roles, error } = await loadDesignations(companyId);
  const flash = loadFlash();
  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const modelById = new Map(models.map((model) => [model.id, model]));
  const categoryNameByCode = new Map(categories.map((category) => [category.code, category.name]));
  const filteredDesignations = designations.filter((designation) => {
    const providerText = designation.provider_ids
      .map((providerId) => providerById.get(providerId))
      .filter(Boolean)
      .map((provider) => `${provider?.code} ${provider?.name}`)
      .join(" ");
    const modelText = (designation.model_ids ?? [])
      .map((modelId) => modelById.get(modelId))
      .filter(Boolean)
      .map((model) => `${model?.code} ${model?.name}`)
      .join(" ");
    const categoryText = normalizeDesignationCategories(designation.onboarding_categories).map((category) => categoryNameByCode.get(category) ?? designationCategoryLabel(category)).join(" ");
    return `${designation.code} ${designation.name} ${providerText} ${modelText} ${categoryText} ${designationProfileDestinationLabel(designation.profile_destination)}`.toLowerCase().includes(query);
  });
  const editDesignation = designations.find((designation) => designation.id === searchParams?.edit) ?? null;

  return (
    <AppShell active="HR Designations" pageCode="designations">
      <PageHead
        eyebrow="People master"
        title="HR Designations"
        subtitle="Manage only employee, HR, contractor and People-owned designations. Workforce roles remain isolated in Workforce."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/designations_v1.sql` in Supabase SQL Editor, then refresh this page.
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
              <h2>Designation list</h2>
              <p className="subtle">{filteredDesignations.length} of {designations.length} records</p>
            </div>
            <div className="master-toolbar">
              <form className="inline-search" action="/master/designations">
                <input className="field" defaultValue={searchParams?.q ?? ""} name="q" placeholder="Search designation or model" />
                <button className="button secondary compact" type="submit">Search</button>
                {query ? <PendingLink className="button secondary compact" href="/master/designations">Clear</PendingLink> : null}
              </form>
              {pagePermission.canAdd ? <PendingLink className="button compact" href="/master/designations?add=1" scroll={false}>Add designation</PendingLink> : null}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Designation</th>
                  <th>Profile destination</th>
                  <th>Categories</th>
                  <th>Models</th>
                  <th>App pages</th>
                  <th>Field operations</th>
                  <th>Status</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredDesignations.length ? filteredDesignations.map((designation) => {
                  const designationModels = (designation.model_ids ?? [])
                    .map((modelId) => modelById.get(modelId))
                    .filter(Boolean) as ModelRow[];
                  return (
                    <tr key={designation.id}>
                      <td><strong>{designation.code}</strong></td>
                      <td>{designation.name}</td>
                      <td><span className={`destination-badge ${designation.profile_destination ?? "unset"}`}>{designationProfileDestinationLabel(designation.profile_destination)}</span></td>
                      <td>
                        <div className="mini-chip-list">
                          {normalizeDesignationCategories(designation.onboarding_categories).map((category) => (
                            <span className="mini-tag" key={category}>{categoryNameByCode.get(category) ?? designationCategoryLabel(category)}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {designationModels.length ? (
                          <div className="mini-chip-list">
                            {designationModels.slice(0, 3).map((model) => <span className="mini-tag" key={model.id}>{model.code}</span>)}
                            {designationModels.length > 3 ? <span className="mini-tag">+{designationModels.length - 3}</span> : null}
                          </div>
                        ) : <span className="subtle">-</span>}
                      </td>
                      <td>
                        {(designation.app_page_access ?? ["dashboard", "attendance", "leave"]).length ? (
                          <div className="mini-chip-list">
                            {(designation.app_page_access ?? ["dashboard", "attendance", "leave"]).map((page) => (
                              <span className="mini-tag" key={page}>{page.replace(/_/g, " ")}</span>
                            ))}
                          </div>
                        ) : <span className="subtle">No pages</span>}
                      </td>
                      <td>{designation.is_field_operations ? <span className="mini-tag">Included</span> : <span className="subtle">-</span>}</td>
                      <td><StatusPill status={designation.is_active ? "Active" : "Inactive"} /></td>
                      {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/designations?edit=${designation.id}`} scroll={false}>Edit</PendingLink></td> : null}
                    </tr>
                  );
                }) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 9 : 8}>No HR designations found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!error && searchParams?.add === "1" && pagePermission.canAdd ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide designation-modal">
            <div className="panel-head">
              <div>
                <h2>Add HR designation</h2>
                <p className="subtle">Configure its People destination, registration policy, DropX One menus and required fields.</p>
              </div>
              <PendingLink className="icon-button" href="/master/designations" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DesignationForm action={createDesignation} businessCategories={businessCategories} categories={categories} peopleModule="people_hr" roles={roles} models={models.map((model) => ({
              id: model.id,
              code: model.code,
              name: model.name,
              provider: (Array.isArray(model.providers) ? model.providers[0] : model.providers)?.name ?? null
            }))} />
          </section>
        </div>
      ) : null}

      {!error && editDesignation && pagePermission.canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide designation-modal">
            <div className="panel-head">
              <div>
                <h2>Edit HR designation</h2>
                <p className="subtle">Changes apply to future and continuing registration steps without moving existing profile records.</p>
              </div>
              <PendingLink className="icon-button" href="/master/designations" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DesignationForm action={updateDesignation} businessCategories={businessCategories} categories={categories} initial={editDesignation} peopleModule="people_hr" roles={roles} models={models.map((model) => ({
              id: model.id,
              code: model.code,
              name: model.name,
              provider: (Array.isArray(model.providers) ? model.providers[0] : model.providers)?.name ?? null
            }))} submitLabel="Save changes" />
            <form action={deleteDesignation} className="danger-form">
              <input name="id" type="hidden" value={editDesignation.id} />
              <SubmitButton
                className="button warning"
                confirmMessage="Delete this designation?"
                confirmSubmitText="Delete"
                pendingText="Deleting"
              >
                Delete designation
              </SubmitButton>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
