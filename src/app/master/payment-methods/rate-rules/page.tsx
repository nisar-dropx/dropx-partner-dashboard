import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { conversionMetricSources, conversionRateTiers } from "@/lib/conversion-rate-rules";
import { createConversionRateRule } from "./actions";
import { ConversionScopeFields } from "./scope-fields";
import { ConversionFormulaFields, ConversionSlabFields } from "./formula-fields";

export const dynamic = "force-dynamic";

export default async function ConversionRateRulesPage({ searchParams }: { searchParams?: { error?: string; saved?: string } }) {
  const authorization = await requirePagePermission("payment_methods", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.payment_methods;
  if (!supabaseAdmin) return <AppShell active="Payment Methods" pageCode="payment_methods"><PageHead title="Conversion rate rules" subtitle="Database connection is unavailable." /></AppShell>;
  const locationIds = authorization.hasAllLocationAccess ? null : authorization.locationScopeIds.length ? authorization.locationScopeIds : ["00000000-0000-0000-0000-000000000000"];
  let stationQuery = supabaseAdmin.from("stations").select("id,station_code,station_name,location_model_id").eq("company_id", companyId).order("station_code");
  let rulesQuery = supabaseAdmin.from("payment_conversion_rate_rules")
    .select("id,name,payment_method_id,payment_field_id,station_id,location_model_id,numerator_source,denominator_source,effective_from,effective_to,tiers").eq("company_id", companyId).order("effective_from", { ascending: false }).order("id");
  if (locationIds) { stationQuery = stationQuery.in("id", locationIds); rulesQuery = rulesQuery.in("station_id", locationIds); }
  const [methods, fields, models, stations, rules, metricOptions] = await Promise.all([
    readAllRows(supabaseAdmin.from("payment_methods").select("id,name,payment_method_components(payment_field_id,is_active)").eq("company_id", companyId).eq("is_active", true).order("id")),
    readAllRows(supabaseAdmin.from("payment_fields").select("id,label").eq("company_id", companyId).eq("field_type", "production").eq("is_active", true).order("id")),
    readAllRows(supabaseAdmin.from("location_models").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("id")),
    readAllRows(stationQuery), readAllRows(rulesQuery), supabaseAdmin.rpc("payment_conversion_metric_options")
  ]);
  const databaseError = [methods, fields, models, stations, rules, metricOptions].find(result => result.error)?.error?.message;
  const metrics = (metricOptions.data ?? []) as { source_key: string; label: string }[];
  const metricNames = new Map(metrics.map(metric => [metric.source_key, metric.label]));
  const methodNames = new Map((methods.data ?? []).map(row => [row.id, row.name]));
  const fieldNames = new Map((fields.data ?? []).map(row => [row.id, row.label]));
  const stationNames = new Map((stations.data ?? []).map(row => [row.id, row.station_code]));
  const modelNames = new Map((models.data ?? []).map(row => [row.id, `${row.code} — ${row.name}`]));
  const tomorrow = new Date(`${todayKolkata()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const minimumDate = tomorrow.toISOString().slice(0, 10);
  return <AppShell active="Payment Methods" pageCode="payment_methods">
    <PageHead eyebrow="Master Data" title="Conversion rate rules" subtitle="Configure conversion inputs and production rates for any payment method, model and location." action={<PendingLink href="/master/payment-methods" className="button secondary">Payment methods</PendingLink>} />
    <section className="panel"><div className="panel-body">
      <p>Daily conversion = sum of selected completed counts ÷ sum of selected base counts × 100, calculated separately for each provider ID at its mapped location.</p>
      <p className="subtle">Choose the payment method, production field and conversion inputs from the available data. The highest qualifying slab sets the rate for that field. Individual rate overrides take priority. With no matching rule or incomplete conversion inputs, the existing fixed rate applies. Future-dated rules preserve existing mappings and payment history.</p>
    </div></section>
    {databaseError || searchParams?.error ? <section className="message-panel error">{databaseError ?? searchParams?.error}</section> : null}
    {searchParams?.saved ? <section className="message-panel success">Conversion rate rule saved for future work dates.</section> : null}
    {permission.canAdd && !databaseError ? <section className="panel"><div className="panel-head"><h2>Add conversion rate rule</h2></div>
      <form action={createConversionRateRule} className="panel-body">
        <div className="form-grid">
          <label>Rule name<input className="field" name="name" required maxLength={160} /></label>
          <ConversionScopeFields methods={methods.data ?? []} fields={fields.data ?? []} models={models.data ?? []} stations={stations.data ?? []} />
          <ConversionFormulaFields metrics={metrics} />
          <label>Effective from<input className="field" type="date" name="effective_from" required min={minimumDate} /></label>
          <label>Effective to<input className="field" type="date" name="effective_to" required min={minimumDate} /></label>
        </div>
        <ConversionSlabFields />
        <p className="subtle">Rules cannot overlap for the same method, field and location. Saved rules are immutable; use a new date range for later rates.</p>
        <SubmitButton className="button">Save conversion rule</SubmitButton>
      </form></section> : null}
    <section className="panel"><div className="panel-head"><h2>Configured conversion rules</h2></div><div className="table-wrap"><table>
      <thead><tr><th>Rule</th><th>Payment method / field</th><th>Model / location</th><th>Conversion</th><th>Slabs</th><th>Work dates</th></tr></thead>
      <tbody>{(rules.data ?? []).map(row => <tr key={row.id}><td>{row.name}</td><td>{methodNames.get(row.payment_method_id) ?? row.payment_method_id}<br />{fieldNames.get(row.payment_field_id) ?? row.payment_field_id}</td><td>{modelNames.get(row.location_model_id) ?? row.location_model_id}<br />{stationNames.get(row.station_id) ?? row.station_id}</td><td>({conversionMetricSources(row.numerator_source).map(source => metricNames.get(source) ?? source).join(" + ")}) ÷ ({conversionMetricSources(row.denominator_source).map(source => metricNames.get(source) ?? source).join(" + ")}) × 100</td><td>{conversionRateTiers(row.tiers).map(tier => `${tier.minimum}% → ₹${tier.rate}`).join(" · ")}</td><td>{row.effective_from} to {row.effective_to}</td></tr>)}
        {!rules.data?.length ? <tr><td colSpan={6} className="empty-cell">No conversion rules. Existing fixed rates continue to apply.</td></tr> : null}
      </tbody></table></div></section>
  </AppShell>;
}
