import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { ProviderFirstMappingWorksheet, type ProviderFirstMappingRow, type ProviderFirstWorker } from "@/components/provider-first-mapping-worksheet";
import type { PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PaymentMethodRow = { id: string; code: string; name: string; payment_method_components: Array<{ component_code: string; component_type: "amount" | "production"; label: string; sort_order: number }> | null };
type Mapping = { id: string; workforce_id: string | null; provider_member_id: string; station_id: string | null; provider_id: string | null; payment_method_id: string | null; payment_values: Record<string, string | number> | null; effective_from: string; effective_to: string | null; status: string };

function flash() {
  const raw = cookies().get("dropx_provider_mapping_flash")?.value;
  try { return raw ? JSON.parse(raw) as { error?: string; notice?: string } : {}; } catch { return {}; }
}

export default async function ProviderFirstMappingPage() {
  const authorization = await requirePagePermission("provider_mapping", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.provider_mapping;
  const canEdit = Boolean(permission?.canAdd || permission?.canEdit);
  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const scope = new Set(authorization.locationScopeIds);
  const allowed = (id: string | null) => allLocations || Boolean(id && scope.has(id));
  const notice = flash();

  if (!supabaseAdmin) return <AppShell active="ID Mapping" pageCode="provider_mapping"><PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" /><section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Supabase service role key is not configured.</p></div></section></AppShell>;

  const [stationsResult, workersResult, providerResult, mappingsResult, methodsResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id, station_code, station_name, provider_id").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, date_of_join, onboarding_status").eq("company_id", companyId).is("deleted_at", null).order("dropx_id"),
    supabaseAdmin.from("cps_shipment_daily").select("provider_employee_id, provider_employee_name, station_code, work_date").eq("company_id", companyId).order("work_date", { ascending: false }).limit(50000),
    supabaseAdmin.from("field_executive_provider_mappings").select("id, workforce_id, provider_member_id, station_id, provider_id, payment_method_id, payment_values, effective_from, effective_to, status").eq("company_id", companyId).neq("status", "cancelled").order("effective_from", { ascending: false }).order("created_at", { ascending: false }),
    supabaseAdmin.from("payment_methods").select("id, code, name, payment_method_components(component_code, component_type, label, sort_order)").eq("company_id", companyId).eq("is_active", true).order("code")
  ]);
  const loadError = stationsResult.error || workersResult.error || providerResult.error || mappingsResult.error || methodsResult.error;
  const stations = (stationsResult.data ?? []).filter((station) => allowed(station.id));
  const stationByCode = new Map(stations.map((station) => [station.station_code, station]));
  const activeMappings = ((mappingsResult.data ?? []) as Mapping[]).filter((mapping) => allowed(mapping.station_id) && !mapping.effective_to);
  const mappingByWorkforce = new Map(activeMappings.filter((mapping) => mapping.workforce_id).map((mapping) => [mapping.workforce_id!, mapping]));
  const mappingByMember = new Map(activeMappings.map((mapping) => [String(mapping.provider_member_id), mapping]));
  const workforceById = new Map((workersResult.data ?? []).map((worker) => [worker.id, worker]));
  const stationLabelById = new Map(stations.map((station) => [station.id, station.station_code]));
  const workers: ProviderFirstWorker[] = (workersResult.data ?? []).filter((worker) => allowed(worker.location_id) && worker.dropx_id).map((worker) => {
    const mapping = mappingByWorkforce.get(worker.id);
    return { id: worker.id, dropxId: String(worker.dropx_id), fullName: String(worker.full_name), stationId: String(worker.location_id ?? ""), providerId: mapping?.provider_id ?? "", dateOfJoin: String(worker.date_of_join ?? ""), mappingId: mapping?.id ?? "", paymentMethodId: mapping?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(mapping?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), effectiveFrom: mapping?.effective_from ?? String(worker.date_of_join ?? ""), effectiveTo: mapping?.effective_to ?? "", mappedProviderMemberId: mapping?.provider_member_id ?? "", locationLabel: stationLabelById.get(String(worker.location_id ?? "")) ?? "No location", onboardingStatus: String(worker.onboarding_status ?? "") };
  });
  const latestMembers = new Map<string, { id: string; name: string; stationId: string; stationLabel: string; providerId: string }>();
  for (const provider of providerResult.data ?? []) {
    const id = String(provider.provider_employee_id ?? "").trim();
    const station = stationByCode.get(String(provider.station_code ?? "").trim());
    if (!id || !station || latestMembers.has(id)) continue;
    latestMembers.set(id, { id, name: String(provider.provider_employee_name ?? "").trim() || "Unnamed provider member", stationId: station.id, stationLabel: station.station_name && station.station_name !== station.station_code ? `${station.station_code} - ${station.station_name}` : station.station_code, providerId: station.provider_id ?? "" });
  }
  const mappings: ProviderFirstMappingRow[] = Array.from(latestMembers.values()).map((member) => {
    const link = mappingByMember.get(member.id);
    const worker = link?.workforce_id ? workforceById.get(link.workforce_id) : null;
    return { providerMemberId: member.id, providerMemberName: member.name, stationId: member.stationId, stationLabel: member.stationLabel, providerId: member.providerId, workforceId: worker?.id ?? "", dropxId: String(worker?.dropx_id ?? ""), dropxName: String(worker?.full_name ?? ""), mappingId: link?.id ?? "", paymentMethodId: link?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(link?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), effectiveFrom: link?.effective_from ?? String(worker?.date_of_join ?? ""), effectiveTo: link?.effective_to ?? "" };
  });
  const paymentMethods: PaymentMethodOption[] = ((methodsResult.data ?? []) as PaymentMethodRow[]).map((method) => ({ id: method.id, code: method.code, name: method.name, components: (method.payment_method_components ?? []).slice().sort((a, b) => a.sort_order - b.sort_order).map((component) => ({ code: component.component_code, label: component.label, type: component.component_type })) }));

  return <AppShell active="ID Mapping" pageCode="provider_mapping">
    <PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" subtitle="Choose the mapping direction that suits the data you are working with." />
    <nav className="performance-tabs" aria-label="ID mapping views"><Link href="/provider-mapping">Existing worksheet</Link><Link className="active" href="/provider-mapping/provider-first">Provider member first</Link></nav>
    {loadError ? <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">{loadError.message}</p></div></section> : null}
    {notice.error || notice.notice ? <section className={`panel message-panel ${notice.error ? "error" : "success"}`}><div className="panel-body"><strong>{notice.error ? "Action required" : "Completed"}</strong><p className="subtle">{notice.error ?? notice.notice}</p></div></section> : null}
    {!loadError ? <ProviderFirstMappingWorksheet canEdit={canEdit} mappings={mappings} paymentMethods={paymentMethods} workers={workers} /> : null}
  </AppShell>;
}
