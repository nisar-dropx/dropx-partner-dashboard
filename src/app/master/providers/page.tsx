import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { MasterDataLists } from "@/components/master-data-lists";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createProvider, updateProvider } from "../../settings/actions";
import { deleteProviderProductionMetric, saveProviderProductionMetric } from "./metric-actions";

type ProviderRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};
type ProviderModelRow = { id: string; provider_id: string | null; code: string; name: string; is_active: boolean };
type ProviderMetricRow = { id: string; provider_id: string; provider_model_id: string | null; code: string; name: string; source_key: string; source_keys: string[] | null; calculation_operation: "direct" | "sum"; sort_order: number; is_active: boolean; providers?: { name?: string } | null; location_models?: { name?: string; code?: string } | null };

async function loadProviders(companyId: string) {
  if (!supabaseAdmin) {
    return {
      providers: [] as ProviderRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const { data, error } = await supabaseAdmin
    .from("providers")
    .select("id, code, name, is_active")
    .eq("company_id", companyId)
    .order("code");

  return {
    providers: (data ?? []) as ProviderRow[],
    error: error?.message ?? null
  };
}

export const dynamic = "force-dynamic";

type ProvidersPageProps = {
  searchParams?: {
    add?: string;
    edit?: string;
    counts?: string;
  };
};

export default async function ProvidersPage({ searchParams }: ProvidersPageProps) {
  const authorization = await requirePagePermission("master_providers", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.master_providers;
  const { providers, error } = await loadProviders(companyId);
  const modelResult = supabaseAdmin ? await supabaseAdmin.from("location_models").select("id, provider_id, code, name, is_active").eq("company_id", companyId).order("provider_id").order("code") : { data: [], error: null };
  const models = (modelResult.data ?? []) as ProviderModelRow[];
  const metricResult = supabaseAdmin ? await supabaseAdmin.from("provider_production_metrics").select("id, provider_id, provider_model_id, code, name, source_key, source_keys, calculation_operation, sort_order, is_active, providers(name), location_models(name,code)").eq("company_id", companyId).order("provider_id").order("provider_model_id").order("sort_order") : { data: [], error: null };
  const metrics = (metricResult.data ?? []) as unknown as ProviderMetricRow[];
  const addType = pagePermission.canAdd ? searchParams?.add : null;
  const [editType, editId] = (searchParams?.edit ?? "").split(":");
  const editProvider = pagePermission.canEdit && editType === "provider" ? providers.find((row) => row.id === editId) : null;

  return (
    <AppShell active="Providers" pageCode="master_providers">
      <PageHead
        eyebrow="Setup"
        title="Providers"
        subtitle="Maintain client and report source masters used by locations, uploads, and payouts."
        action={<div className="page-head-actions">{pagePermission.canEdit ? <Link className="button secondary" href="/master/providers?counts=1" scroll={false}>Production Counts</Link> : null}<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span></div>}
      />

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run the master-data SQL migration and add `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
            </p>
          </div>
        </section>
      ) : null}

      {pagePermission.canView || pagePermission.canEdit ? (
        <MasterDataLists
          canAdd={pagePermission.canAdd}
          canEdit={pagePermission.canEdit}
          locations={[]}
          models={[]}
          providers={providers}
          sections={["providers"]}
        />
      ) : null}

      {addType === "provider" ? (
        <div className="modal-backdrop">
          <section className="modal-panel" aria-label="Add provider">
            <div className="panel-head">
              <div><h2>Add provider</h2><p className="subtle">Create a client or report source.</p></div>
              <Link className="icon-button" href="/master/providers" scroll={false} aria-label="Close add provider">x</Link>
            </div>
            <form action={createProvider} className="form-grid">
              <label>Provider code<input className="field" name="code" placeholder="Enter provider code" required /></label>
              <label>Provider name<input className="field" name="name" placeholder="Enter provider name" required /></label>
              <label>Status<select className="select" name="is_active" defaultValue="active"><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
              <div className="form-actions modal-actions">
                <Link className="button secondary" href="/master/providers" scroll={false}>Cancel</Link>
                <SubmitButton>Add provider</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {editProvider ? (
        <div className="modal-backdrop">
          <section className="modal-panel" aria-label="Edit provider">
            <div className="panel-head">
              <div>
                <h2>Edit provider</h2>
                <p className="subtle">Internal ID stays hidden and unchanged.</p>
              </div>
              <Link className="icon-button" href="/master/providers" scroll={false} aria-label="Close edit provider">x</Link>
            </div>
            <form action={updateProvider} className="form-grid">
              <input type="hidden" name="id" value={editProvider.id} />
              <label>Provider code<input className="field" name="code" defaultValue={editProvider.code} required /></label>
              <label>Provider name<input className="field" name="name" defaultValue={editProvider.name} required /></label>
              <label>Status
                <select className="select" name="is_active" defaultValue={editProvider.is_active ? "active" : "inactive"}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <div className="form-actions">
                <SubmitButton>Save changes</SubmitButton>
                <Link className="button secondary" href="/master/providers" scroll={false}>Cancel</Link>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {searchParams?.counts === "1" && pagePermission.canEdit ? <div className="modal-backdrop"><section className="modal-panel wide provider-counts-modal" aria-label="Provider production counts">
        <div className="panel-head"><div><h2>Production Count Master</h2><p className="subtle">Configure what each provider and operating model reports. Payment Fields reuse these counts; individual rates stay in ID &amp; pay mapping.</p></div><Link className="icon-button" href="/master/providers" scroll={false}>x</Link></div>
        <div className="panel-body">
          <section className="provider-count-create"><div><h3>Add production count</h3><p className="subtle">Use one imported key for a direct count, or comma-separated keys to add values together.</p></div>
            <form action={saveProviderProductionMetric} className="provider-count-form">
              <label>Provider<select className="select" name="provider_id" required><option value="">Select provider</option>{providers.filter((provider) => provider.is_active).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
              <label>Operating model<select className="select" name="provider_model_id"><option value="">All models (fallback)</option>{models.filter((model) => model.is_active).map((model) => <option key={model.id} value={model.id}>{providers.find((provider) => provider.id === model.provider_id)?.name} · {model.code} — {model.name}</option>)}</select></label>
              <label>Count ID<input className="field mono" name="code" placeholder="TOTAL_DELIVERY" required /></label>
              <label>Display name<input className="field" name="name" placeholder="Total Delivery" required /></label>
              <label>Calculation<select className="select" name="calculation_operation" defaultValue="direct"><option value="direct">Use one imported count</option><option value="sum">Add imported counts together</option></select></label>
              <label className="provider-count-sources">Imported data key(s)<input className="field mono" name="source_keys" placeholder="amazon_delivery, swa_delivery" required /><small>These are normalized keys from the provider upload. Separate multiple keys with commas.</small></label>
              <label>Display order<input className="field" type="number" name="sort_order" defaultValue="0" /></label>
              <div className="form-actions"><SubmitButton>Add production count</SubmitButton></div>
            </form>
          </section>
          <div className="provider-count-groups">{providers.map((provider) => { const providerMetrics = metrics.filter((metric) => metric.provider_id === provider.id); if (!providerMetrics.length) return null; return <section className="provider-count-group" key={provider.id}><div className="provider-count-group-head"><div><h3>{provider.name}</h3><span>{providerMetrics.length} configured count{providerMetrics.length === 1 ? "" : "s"}</span></div></div><div className="table-wrap"><table><thead><tr><th>Model</th><th>Production count</th><th>Calculation</th><th>Imported data</th><th>Status</th><th>Action</th></tr></thead><tbody>{providerMetrics.map((metric) => <tr key={metric.id}><td><strong>{metric.location_models?.code ?? "All"}</strong><small>{metric.location_models?.name ?? "All models fallback"}</small></td><td><strong>{metric.name}</strong><small>{metric.code}</small></td><td>{metric.calculation_operation === "sum" ? "Add counts" : "Direct count"}</td><td><code>{(metric.source_keys?.length ? metric.source_keys : [metric.source_key]).join(" + ")}</code></td><td><StatusPill status={metric.is_active ? "Active" : "Inactive"}/></td><td><form action={deleteProviderProductionMetric}><input type="hidden" name="id" value={metric.id}/><SubmitButton className="button warning compact" confirmMessage={`Delete ${metric.name}? It can be deleted only when it is not used by a Payment Field.`}>Delete</SubmitButton></form></td></tr>)}</tbody></table></div></section>; })}</div>
          {!metrics.length ? <div className="empty-cell">No production counts configured. Add the first provider/model count above.</div> : null}
        </div>
      </section></div> : null}
    </AppShell>
  );
}
