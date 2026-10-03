import { cookies } from "next/headers";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { ProviderFirstMappingWorksheet, type ProviderFirstMappingRow, type ProviderFirstWorker } from "@/components/provider-first-mapping-worksheet";
import type { PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canonicalizeProviderFirstMembers, providerMemberKey, providerSourceMemberKey } from "@/lib/provider-first-mapping-view";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

type PaymentMethodRow = { id: string; code: string; name: string; is_active: boolean; payment_method_components: Array<{ component_code: string; component_type: "amount" | "production"; label: string; sort_order: number; payment_fields: { calculation_source: string | null; calculation_type: string | null } | Array<{ calculation_source: string | null; calculation_type: string | null }> | null }> | null };
type Mapping = { id: string; workforce_id: string | null; provider_member_id: string; station_id: string | null; provider_id: string | null; payment_method_id: string | null; payment_values: Record<string, string | number> | null; effective_from: string; effective_to: string | null; status: string };
type ProviderMemberSource = { provider_employee_id: unknown; provider_employee_name: unknown; station_code: unknown; work_date: unknown };

function flash() {
  const raw = cookies().get("dropx_provider_mapping_flash")?.value;
  try { return raw ? JSON.parse(raw) as { error?: string; notice?: string } : {}; } catch { return {}; }
}

export default async function ProviderFirstMappingPage({searchParams}: {searchParams?: {q?:string;station?:string}}) {
  const authorization = await requirePagePermission("provider_mapping", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.provider_mapping;
  const canEdit = Boolean(permission?.canAdd || permission?.canEdit);
  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const scope = new Set(authorization.locationScopeIds);
  const allowed = (id: string | null) => allLocations || Boolean(id && scope.has(id));
  const notice = flash();

  if (!supabaseAdmin) return <AppShell active="ID Mapping" pageCode="provider_mapping"><PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" /><section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Supabase service role key is not configured.</p></div></section></AppShell>;

  const [stationsResult, workersResult, providerResult, mappingsResult, methodsResult, designationsResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id, station_code, station_name, provider_id").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, date_of_join, onboarding_status, designation_id, designation").eq("company_id", companyId).is("deleted_at", null).order("dropx_id"),
    supabaseAdmin.rpc("ops_cps_mapping_members", {p_company:companyId,p_station_ids:allLocations?null:authorization.locationScopeIds}),
    readAllRows(supabaseAdmin.from("field_executive_provider_mappings").select("id, workforce_id, provider_member_id, station_id, provider_id, payment_method_id, payment_values, effective_from, effective_to, status").eq("company_id", companyId).neq("status", "cancelled").order("effective_from", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false })),
    supabaseAdmin.from("payment_methods").select("id, code, name, is_active, payment_method_components(component_code, component_type, label, sort_order, payment_fields(calculation_source, calculation_type))").eq("company_id", companyId).order("code"),
    supabaseAdmin.from("designations").select("id, code, name, is_field_operations, provider_mapping_required").eq("company_id", companyId).eq("is_active", true)
  ]);
  const loadError = stationsResult.error || workersResult.error || providerResult.error || mappingsResult.error || methodsResult.error || designationsResult.error;
  const allStations = stationsResult.data ?? [];
  const stations = allStations.filter((station) => allowed(station.id));
  const stationByCode = new Map(stations.map((station) => [String(station.station_code ?? "").trim().toUpperCase(), station]));
  const stationCodeById = new Map(allStations.map((station) => [String(station.id), String(station.station_code ?? "").trim()]));
  const allMappingHistory = (mappingsResult.data ?? []) as Mapping[];
  const mappingHistory = allMappingHistory.filter((mapping) => allowed(mapping.station_id));
  const activeMappings = mappingHistory.filter((mapping) => !mapping.effective_to);
  const mappedSourceMemberKeys = new Set(allMappingHistory.map((mapping) => {
    const stationCode = stationCodeById.get(String(mapping.station_id ?? ""));
    return providerSourceMemberKey(stationCode || "*", mapping.provider_member_id);
  }));
  const mappingByWorkforce = new Map<string, Mapping>();
  const mappingByMember = new Map<string, Mapping>();
  for (const mapping of activeMappings) {
    if (mapping.workforce_id && !mappingByWorkforce.has(mapping.workforce_id)) mappingByWorkforce.set(mapping.workforce_id, mapping);
    const memberKey = providerMemberKey(String(mapping.station_id ?? ""), String(mapping.provider_member_id ?? ""));
    if (!mappingByMember.has(memberKey)) mappingByMember.set(memberKey, mapping);
  }
  const workforceById = new Map((workersResult.data ?? []).map((worker) => [worker.id, worker]));
  const designationById = new Map((designationsResult.data ?? []).map((designation) => [String(designation.id), designation]));
  const designationByName = new Map((designationsResult.data ?? []).flatMap((designation) => [designation.name, designation.code].map((value) => [String(value ?? "").trim().toLowerCase(), designation] as const)));
  const stationLabelById = new Map(stations.map((station) => [station.id, station.station_code]));
  const workers: ProviderFirstWorker[] = (workersResult.data ?? []).filter((worker) => {
    const designation = designationById.get(String(worker.designation_id ?? "")) ?? designationByName.get(String(worker.designation ?? "").trim().toLowerCase());
    return allowed(worker.location_id) && worker.dropx_id && (mappingByWorkforce.has(worker.id) || designation?.is_field_operations && designation.provider_mapping_required !== false);
  }).map((worker) => {
    const mapping = mappingByWorkforce.get(worker.id);
    return { id: worker.id, dropxId: String(worker.dropx_id), fullName: String(worker.full_name), stationId: String(worker.location_id ?? ""), providerId: mapping?.provider_id ?? "", dateOfJoin: String(worker.date_of_join ?? ""), mappingId: mapping?.id ?? "", paymentMethodId: mapping?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(mapping?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), effectiveFrom: mapping?.effective_from ?? String(worker.date_of_join ?? ""), effectiveTo: mapping?.effective_to ?? "", mappedProviderMemberId: mapping?.provider_member_id ?? "", locationLabel: stationLabelById.get(String(worker.location_id ?? "")) ?? "No location", onboardingStatus: String(worker.onboarding_status ?? "") };
  });
  const providerMembers = canonicalizeProviderFirstMembers(((providerResult.data ?? []) as ProviderMemberSource[]).map((provider) => ({
    providerMemberId: String(provider.provider_employee_id ?? "").trim(),
    providerMemberName: String(provider.provider_employee_name ?? "").trim(),
    stationCode: String(provider.station_code ?? "").trim(),
    workDate: String(provider.work_date ?? "")
  })), mappedSourceMemberKeys);
  const latestMembers = new Map<string, { id: string; name: string; stationId: string; stationLabel: string; providerId: string }>();
  for (const provider of providerMembers) {
    const id = provider.providerMemberId;
    const station = stationByCode.get(provider.stationCode.toUpperCase());
    const memberKey = station ? providerMemberKey(station.id, id) : "";
    if (!id || !station || latestMembers.has(memberKey)) continue;
    latestMembers.set(memberKey, { id, name: provider.providerMemberName || "Unnamed provider member", stationId: station.id, stationLabel: station.station_name && station.station_name !== station.station_code ? `${station.station_code} - ${station.station_name}` : station.station_code, providerId: station.provider_id ?? "" });
  }
  const mappings: ProviderFirstMappingRow[] = Array.from(latestMembers.values()).map((member) => {
    const link = mappingByMember.get(providerMemberKey(member.stationId, member.id));
    const worker = link?.workforce_id ? workforceById.get(link.workforce_id) : null;
    return { providerMemberId: member.id, providerMemberName: member.name, stationId: member.stationId, stationLabel: member.stationLabel, providerId: member.providerId, workforceId: worker?.id ?? "", dropxId: String(worker?.dropx_id ?? ""), dropxName: String(worker?.full_name ?? ""), mappingId: link?.id ?? "", paymentMethodId: link?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(link?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), effectiveFrom: link?.effective_from ?? String(worker?.date_of_join ?? ""), effectiveTo: link?.effective_to ?? "" };
  });
  const paymentMethods: PaymentMethodOption[] = ((methodsResult.data ?? []) as PaymentMethodRow[])
    .map((method) => ({ id: method.id, code: method.code, name: method.name, isActive: method.is_active, components: (method.payment_method_components ?? []).slice().sort((a, b) => a.sort_order - b.sort_order).map((component) => ({ code: component.component_code, label: component.label, type: component.component_type })) }));
  const requestedStation = String(searchParams?.station ?? "").trim();
  const initialStationId = stations.find((station) => station.id === requestedStation || String(station.station_code ?? "").trim().toUpperCase() === requestedStation.toUpperCase())?.id ?? "";

  return <AppShell active="ID Mapping" pageCode="provider_mapping">
    <PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" subtitle="Map provider members to available DropX workforce IDs and payment rates." />
    <nav className="performance-tabs" aria-label="ID mapping views"><Link href="/provider-mapping">Existing worksheet</Link><Link className="active" href="/provider-mapping/provider-first">Provider member first</Link><Link href="/provider-mapping/direct-pay">Direct pay allocations</Link></nav>
    
    {loadError ? <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">{loadError.message}</p></div></section> : null}
    {notice.error || notice.notice ? <section className={`panel message-panel ${notice.error ? "error" : "success"}`}><div className="panel-body"><strong>{notice.error ? "Action required" : "Completed"}</strong><p className="subtle">{notice.error ?? notice.notice}</p></div></section> : null}
    {!loadError ? <ProviderFirstMappingWorksheet initialQuery={searchParams?.q} initialStationId={initialStationId} canEdit={canEdit} mappings={mappings} paymentMethods={paymentMethods} workers={workers} /> : null}
  </AppShell>;
}
