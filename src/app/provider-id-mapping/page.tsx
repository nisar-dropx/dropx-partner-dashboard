import { providerMappingEntryFilters } from "@/lib/provider-mapping-navigation";
import { cookies } from "next/headers";
import { dashboardDateInputValue } from "@/lib/date-format";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { ProviderFirstMappingWorksheet, type ProviderFirstMappingRow, type ProviderFirstWorker } from "@/components/provider-first-mapping-worksheet";
import type { PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canonicalizeProviderFirstMembers, mergeProviderFirstLocationMembers, providerFirstLocationMappingEntries, providerFirstMappingForOutboundMonth, providerFirstMappingIsCurrentOrScheduled, providerMemberIdentityKey, providerMemberKey, providerSourceMemberKey, providerMappingStationFamily } from "@/lib/provider-first-mapping-view";
import { paymentAllocationHistoryRates, sortPaymentAllocationHistory, uniquePaymentAllocationHistory, type PaymentAllocationHistoryEntry } from "@/lib/payment-allocation-history";
import { parseProductionThresholdConfig } from "@/lib/production-threshold-config";
import { parseProductionThresholdSnapshot } from "@/lib/production-threshold-snapshot";
import { canEditProviderMappings, currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { nlPeopleClusters } from "@/lib/ops-pulse/nl-loss-clusters";

import type { ProviderMappingLookupEntry } from "@/lib/provider-mapping-lookup";

type PaymentMethodRow = { id: string; code: string; name: string; is_active: boolean; production_threshold_config: unknown; payment_method_components: Array<{ component_code: string; component_type: "amount" | "production"; label: string; sort_order: number }> | null };
type Mapping = { id: string; workforce_id: string | null; provider_member_id: string; station_id: string | null; provider_id: string | null; payment_method_id: string | null; payment_values: Record<string, string | number> | null; production_threshold_config: unknown; effective_from: string; effective_to: string | null; status: string; reason: string | null; updated_at: string };
type ProviderMemberSource = { provider_employee_id: unknown; provider_employee_name: unknown; station_code: unknown; work_date: unknown; shipment_months?: string[]; outbound_months?: string[] };

function flash() {
  const raw = cookies().get("dropx_provider_mapping_flash")?.value;
  try { return raw ? JSON.parse(raw) as { error?: string; notice?: string } : {}; } catch { return {}; }
}

function appendMapValue<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

export default async function ProviderIdMappingPage({searchParams}: {searchParams?: {q?:string;station?:string;month?:string;mapping?:string}}) {
  const pageCode = currentProviderMappingPageCode();
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = canEditProviderMappings(authorization);
  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const scope = new Set(authorization.locationScopeIds);
  const allowed = (id: string | null) => allLocations || Boolean(id && scope.has(id));
  const notice = flash();
  const today = dashboardDateInputValue();
  const entryFilters = providerMappingEntryFilters(searchParams, today);

  if (!supabaseAdmin) return <AppShell active="ID Mapping" pageCode={pageCode}><PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" /><section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Supabase service role key is not configured.</p></div></section></AppShell>;

  const [stationsResult, workersResult, providerResult, mappingsResult, methodsResult, designationsResult] = await Promise.all([
    // Payouts and mapping history remain valid after a station is deactivated.
    // Load every authorized company station so those stored mappings do not
    // disappear from this historical reconciliation screen.
    supabaseAdmin.from("stations").select("id, station_code, station_name, provider_id, parent_station_id, location_models(code)").eq("company_id", companyId).order("station_code"),
    readAllRows(supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, date_of_join, onboarding_status, designation_id, designation").eq("company_id", companyId).is("deleted_at", null).order("id")),
    supabaseAdmin.rpc("ops_cps_mapping_members", {p_company:companyId,p_station_ids:allLocations?null:authorization.locationScopeIds}),
    readAllRows(supabaseAdmin.from("field_executive_provider_mappings").select("id, workforce_id, provider_member_id, station_id, provider_id, payment_method_id, payment_values, production_threshold_config, effective_from, effective_to, status, reason, updated_at").eq("company_id", companyId).order("effective_from", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false })),
    supabaseAdmin.from("payment_methods").select("id, code, name, is_active, production_threshold_config, payment_method_components(component_code, component_type, label, sort_order)").eq("company_id", companyId).order("code"),
    supabaseAdmin.from("designations").select("id, code, name, provider_mapping_required").eq("company_id", companyId).eq("is_active", true)
  ]);
  const loadError = stationsResult.error || workersResult.error || providerResult.error || mappingsResult.error || methodsResult.error || designationsResult.error;
  const allStations = stationsResult.data ?? [];
  const stations = allStations.filter((station) => allowed(station.id));
  const stationByCode = new Map(stations.map((station) => [String(station.station_code ?? "").trim().toUpperCase(), station]));
  const stationById = new Map(stations.map((station) => [String(station.id), station]));
  const stationCodeById = new Map(allStations.map((station) => [String(station.id), String(station.station_code ?? "").trim()]));
  const allMappingHistory = (mappingsResult.data ?? []) as Mapping[];
  const mappingHistory = allMappingHistory.filter((mapping) => allowed(mapping.station_id));
  const hasCurrentOrScheduledPeriod = (mapping: Mapping) => providerFirstMappingIsCurrentOrScheduled({ status: mapping.status, effectiveTo: mapping.effective_to }, today);
  const activeMappings = mappingHistory.filter(hasCurrentOrScheduledPeriod);
  const restrictedWorkerIds = new Set(allMappingHistory.filter(mapping => hasCurrentOrScheduledPeriod(mapping) && !allowed(mapping.station_id)).map(mapping => mapping.workforce_id));
  const topology = stations.map(station => ({ ...station, modelCode: (Array.isArray(station.location_models) ? station.location_models[0] : station.location_models)?.code ?? "" }));
  const relatedStationIdsByStation = new Map(stations.map((station) => [station.id, providerMappingStationFamily(station.id, topology)]));
  const profileStationByWorkforce = new Map((workersResult.data ?? []).map((worker) => [
    String(worker.id),
    String(worker.location_id ?? "")
  ]));
  const mappedSourceMemberKeys = new Set(allMappingHistory.map((mapping) => {
    const stationCode = stationCodeById.get(String(mapping.station_id ?? ""));
    return providerSourceMemberKey(stationCode || "*", mapping.provider_member_id);
  }));
  const mappingByWorkforce = new Map<string, Mapping>();
  const currentMappingsByWorkforce = new Map<string, Mapping[]>();
  const mappingByMember = new Map<string, Mapping>();
  for (const mapping of activeMappings) {
    if (mapping.workforce_id) {
      appendMapValue(currentMappingsByWorkforce, mapping.workforce_id, mapping);
      const current = mappingByWorkforce.get(mapping.workforce_id);
      const profileStationId = profileStationByWorkforce.get(mapping.workforce_id) ?? "";
      if (!current
        || (String(mapping.station_id ?? "") === profileStationId
          && String(current.station_id ?? "") !== profileStationId)) {
        mappingByWorkforce.set(mapping.workforce_id, mapping);
      }
    }
    const memberKey = providerMemberKey(String(mapping.station_id ?? ""), String(mapping.provider_member_id ?? ""));
    if (!mappingByMember.has(memberKey)) mappingByMember.set(memberKey, mapping);
  }
  const registeredMappingByWorkforce = new Map<string, Mapping[]>();
  const mappingHistoryByWorkforce = new Map<string, Mapping[]>();
  for (const mapping of mappingHistory) {
    const canonicalPeriod = (mapping.status === "active" && !mapping.effective_to)
      || (mapping.status === "closed" && Boolean(mapping.effective_to));
    if (!mapping.workforce_id || !canonicalPeriod) continue;
    appendMapValue(mappingHistoryByWorkforce, mapping.workforce_id, mapping);
    const profileStationId = profileStationByWorkforce.get(mapping.workforce_id) ?? "";
    if (!profileStationId || String(mapping.station_id ?? "") !== profileStationId) continue;
    appendMapValue(registeredMappingByWorkforce, mapping.workforce_id, mapping);
  }
  const workforceById = new Map((workersResult.data ?? []).map((worker) => [worker.id, worker]));
  const designationById = new Map((designationsResult.data ?? []).map((designation) => [String(designation.id), designation]));
  const designationByName = new Map((designationsResult.data ?? []).flatMap((designation) => [designation.name, designation.code].map((value) => [String(value ?? "").trim().toLowerCase(), designation] as const)));
  const stationLabelById = new Map(stations.map((station) => [station.id, station.station_code]));
  const paymentMethods: PaymentMethodOption[] = ((methodsResult.data ?? []) as PaymentMethodRow[])
    .map((method) => ({ id: method.id, code: method.code, name: method.name, isActive: method.is_active, productionThresholdConfig: parseProductionThresholdConfig(method.production_threshold_config), components: (method.payment_method_components ?? []).slice().sort((a, b) => a.sort_order - b.sort_order).map((component) => ({ code: component.component_code, label: component.label, type: component.component_type })) }));
  const rawMethodById = new Map(((methodsResult.data ?? []) as PaymentMethodRow[]).map((method) => [method.id, method]));
  const historyByMember = new Map<string, PaymentAllocationHistoryEntry[]>();
  const historyByProviderMember = new Map<string, PaymentAllocationHistoryEntry[]>();
  const historyByWorkforce = new Map<string, PaymentAllocationHistoryEntry[]>();
  const historyEntryByMappingId = new Map<string, PaymentAllocationHistoryEntry>();
  const mappingHistoryByMember = new Map<string, Mapping[]>();
  for (const mapping of mappingHistory) {
    const key = providerMemberKey(String(mapping.station_id ?? ""), mapping.provider_member_id);
    appendMapValue(mappingHistoryByMember, key, mapping);
    const method = rawMethodById.get(String(mapping.payment_method_id ?? ""));
    const worker = mapping.workforce_id ? workforceById.get(mapping.workforce_id) : null;
    const entry: PaymentAllocationHistoryEntry = {
      id: mapping.id,
      updatedAt: mapping.updated_at,
      paymentMethodId: String(mapping.payment_method_id ?? ""),
      paymentMethodName: method?.name ?? "Payment method unavailable",
      effectiveFrom: mapping.effective_from,
      effectiveTo: mapping.effective_to ?? "",
      storedStatus: mapping.status,
      sourceLabel: `Provider ID ${mapping.provider_member_id}`,
      subjectLabel: worker ? `${worker.dropx_id ?? ""} · ${worker.full_name ?? ""}`.replace(/^ · | · $/g, "") : "",
      locationLabel: stationLabelById.get(String(mapping.station_id ?? "")) ?? "",
      reason: mapping.reason ?? "",
      productionThreshold: parseProductionThresholdSnapshot(mapping.production_threshold_config),
      rates: paymentAllocationHistoryRates(mapping.payment_values, (method?.payment_method_components ?? []).map((component) => ({ code: component.component_code, label: component.label, sortOrder: component.sort_order })))
    };
    historyEntryByMappingId.set(mapping.id, entry);
    appendMapValue(historyByMember, key, entry);
    const providerMemberIdentity = mapping.provider_id
      ? providerMemberIdentityKey(mapping.provider_id, mapping.provider_member_id)
      : "";
    if (providerMemberIdentity) appendMapValue(historyByProviderMember, providerMemberIdentity, entry);
    if (mapping.workforce_id) appendMapValue(historyByWorkforce, mapping.workforce_id, entry);
  }
  // A month-scoped worksheet must edit the stored period that actually applies
  // in that month. Do not add these historical rows to currentMappings or to
  // the worker's current ownership fields.
  const worksheetMappingByMember = new Map(mappingByMember);
  if (entryFilters.month) {
    worksheetMappingByMember.clear();
    for (const [key, candidates] of mappingHistoryByMember) {
      const selected = providerFirstMappingForOutboundMonth(candidates.map((mapping) => ({
        mapping,
        mappingId: mapping.id,
        effectiveFrom: mapping.effective_from,
        effectiveTo: mapping.effective_to,
        status: mapping.status
      })), entryFilters.month)?.mapping;
      if (selected) worksheetMappingByMember.set(key, selected);
    }
  }
  const workers: ProviderFirstWorker[] = (workersResult.data ?? []).filter((worker) => {
    const designation = designationById.get(String(worker.designation_id ?? "")) ?? designationByName.get(String(worker.designation ?? "").trim().toLowerCase());
    return allowed(worker.location_id) && worker.dropx_id && (mappingByWorkforce.has(worker.id) || registeredMappingByWorkforce.has(worker.id) || Boolean(designation && designation.provider_mapping_required !== false));
  }).map((worker) => {
    const registeredMappings = registeredMappingByWorkforce.get(worker.id) ?? [];
    const activeWorkerMappings = currentMappingsByWorkforce.get(worker.id) ?? [];
    // Current mapping fields describe only an active, open mapping. Historical
    // registered-location rows are evidence for bounded Keep all operations,
    // but must not make an otherwise unmapped worker look currently mapped.
    const mapping = mappingByWorkforce.get(worker.id);
    const thresholdSnapshot = parseProductionThresholdSnapshot(mapping?.production_threshold_config);
    const profileStationId = String(worker.location_id ?? "");
    const mappingStationId = String(mapping?.station_id ?? profileStationId);
    const mappingView = (stored: Mapping) => {
      const storedThreshold = parseProductionThresholdSnapshot(stored.production_threshold_config);
      return { mappingId: stored.id, stationId: String(stored.station_id ?? ""), locationLabel: stationLabelById.get(String(stored.station_id ?? "")) ?? "No location", providerId: String(stored.provider_id ?? ""), mappedProviderMemberId: stored.provider_member_id, paymentMethodId: String(stored.payment_method_id ?? ""), paymentValues: Object.fromEntries(Object.entries(stored.payment_values ?? {}).map(([key, value]) => [key, String(value)])), productionThresholdConfig: storedThreshold ? { period: storedThreshold.period, component_codes: storedThreshold.component_codes } : null, productionThresholdMinimumUnits: storedThreshold ? String(storedThreshold.minimum_units) : "", effectiveFrom: stored.effective_from, effectiveTo: stored.effective_to ?? "", status: stored.status as "active" | "closed" };
    };
    const currentMappings = activeWorkerMappings.map(mappingView);
    const completeMappingHistory = (mappingHistoryByWorkforce.get(worker.id) ?? []).map(mappingView);
    const registeredLocationMappings = registeredMappings.map(mappingView);
    return { hasRestrictedMapping: restrictedWorkerIds.has(worker.id), id: worker.id, dropxId: String(worker.dropx_id), fullName: String(worker.full_name), stationId: mappingStationId, providerId: mapping?.provider_id ?? "", dateOfJoin: String(worker.date_of_join ?? ""), mappingId: mapping?.id ?? "", paymentMethodId: mapping?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(mapping?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), productionThresholdConfig: thresholdSnapshot ? { period: thresholdSnapshot.period, component_codes: thresholdSnapshot.component_codes } : null, productionThresholdMinimumUnits: thresholdSnapshot ? String(thresholdSnapshot.minimum_units) : "", effectiveFrom: mapping?.effective_from ?? String(worker.date_of_join ?? ""), effectiveTo: mapping?.effective_to ?? "", mappedProviderMemberId: mapping?.provider_member_id ?? "", locationLabel: stationLabelById.get(mappingStationId) ?? "No location", profileStationId, profileLocationLabel: stationLabelById.get(profileStationId) ?? "No location", currentMappings, mappingHistory: completeMappingHistory, registeredLocationMappings, registeredLocationMapping: registeredLocationMappings[0], onboardingStatus: String(worker.onboarding_status ?? "") };
  });
  const providerMembers = canonicalizeProviderFirstMembers(((providerResult.data ?? []) as ProviderMemberSource[]).map((provider) => ({
    providerMemberId: String(provider.provider_employee_id ?? "").trim(),
    providerMemberName: String(provider.provider_employee_name ?? "").trim(),
    stationCode: String(provider.station_code ?? "").trim(),
    shipmentMonths: provider.shipment_months ?? [],
    outboundMonths: provider.outbound_months ?? [],
    workDate: String(provider.work_date ?? "")
  })), mappedSourceMemberKeys);
  const sourceLocationMembers: Array<{ id: string; name: string; stationId: string; stationLabel: string; providerId: string; outboundMonths: string[] }> = [];
  for (const provider of providerMembers) {
    const id = provider.providerMemberId;
    const station = stationByCode.get(provider.stationCode.toUpperCase());
    if (!id || !station) continue;
    sourceLocationMembers.push({ outboundMonths: provider.outboundMonths, id, name: provider.providerMemberName || "Unnamed provider member", stationId: station.id, stationLabel: station.station_name && station.station_name !== station.station_code ? `${station.station_code} - ${station.station_name}` : station.station_code, providerId: station.provider_id ?? "" });
  }
  const latestMembers = new Map(mergeProviderFirstLocationMembers(
    sourceLocationMembers,
    (entryFilters.month ? Array.from(worksheetMappingByMember.values()) : activeMappings).flatMap((mapping) => {
      const station = mapping.station_id ? stationById.get(String(mapping.station_id)) : null;
      if (!station || !mapping.provider_member_id) return [];
      const worker = mapping.workforce_id ? workforceById.get(mapping.workforce_id) : null;
      return [{
        id: mapping.provider_member_id,
        name: String(worker?.full_name ?? ""),
        stationId: String(station.id),
        stationLabel: station.station_name && station.station_name !== station.station_code ? `${station.station_code} - ${station.station_name}` : station.station_code,
        providerId: String(mapping.provider_id ?? station.provider_id ?? "")
      }];
    })
  ).map((member) => [providerMemberKey(member.stationId, member.id), member]));
  const mappings: ProviderFirstMappingRow[] = providerFirstLocationMappingEntries(
    Array.from(latestMembers.values()),
    worksheetMappingByMember,
    historyByMember
  ).map(({ member, mapping: link, history: exactMemberHistory }) => {
    const worker = link?.workforce_id ? workforceById.get(link.workforce_id) : null;
    // A provider member can move between locations. History is identity-wide
    // evidence for the operator, but the current row remains location-specific:
    // never turn a prior-location mapping into a mapping at this location.
    const identityHistory = member.providerId
      ? historyByProviderMember.get(providerMemberIdentityKey(member.providerId, member.id)) ?? []
      : [];
    const history = link?.workforce_id
      ? historyByWorkforce.get(link.workforce_id) ?? []
      : uniquePaymentAllocationHistory([...exactMemberHistory, ...identityHistory]);
    const thresholdSnapshot = parseProductionThresholdSnapshot(link?.production_threshold_config);
    return { relatedStationIds: relatedStationIdsByStation.get(member.stationId) ?? [member.stationId], outboundMonths: member.outboundMonths, providerMemberId: member.id, providerMemberName: member.name, stationId: member.stationId, stationLabel: member.stationLabel, providerId: member.providerId, workforceId: worker?.id ?? "", dropxId: String(worker?.dropx_id ?? ""), dropxName: String(worker?.full_name ?? ""), mappingId: link?.id ?? "", paymentMethodId: link?.payment_method_id ?? "", paymentValues: Object.fromEntries(Object.entries(link?.payment_values ?? {}).map(([key, value]) => [key, String(value)])), productionThresholdConfig: thresholdSnapshot ? { period: thresholdSnapshot.period, component_codes: thresholdSnapshot.component_codes } : null, productionThresholdMinimumUnits: thresholdSnapshot ? String(thresholdSnapshot.minimum_units) : "", effectiveFrom: link?.effective_from ?? String(worker?.date_of_join ?? ""), effectiveTo: link?.effective_to ?? "", history: sortPaymentAllocationHistory(history) };
  });
  // Lookup is independent of outbound/month/status filters, but never of authorization.
  const lookupEntries: ProviderMappingLookupEntry[] = mappingHistory.map(mapping => {
    const worker = mapping.workforce_id ? workforceById.get(mapping.workforce_id) : null;
    const member = latestMembers.get(providerMemberKey(String(mapping.station_id ?? ""), mapping.provider_member_id));
    const entry = historyEntryByMappingId.get(mapping.id);
    return { key: mapping.id, stationId: String(mapping.station_id ?? ""), stationLabel: stationLabelById.get(String(mapping.station_id ?? "")) ?? "No location", workforceId: mapping.workforce_id ?? "", dropxId: String(worker?.dropx_id ?? ""), fullName: String(worker?.full_name ?? ""), providerMemberId: mapping.provider_member_id, providerMemberName: member?.name ?? "", profileLocationLabel: stationLabelById.get(String(worker?.location_id ?? "")) ?? "Not in permitted locations", history: entry ? [entry] : [] };
  });
  for (const worker of workers) {
    if (worker.currentMappings?.length) continue;
    lookupEntries.push({ key: `worker:${worker.id}`, stationId: worker.profileStationId ?? "", stationLabel: worker.profileLocationLabel ?? "", workforceId: worker.id, dropxId: worker.dropxId, fullName: worker.fullName, providerMemberId: "", providerMemberName: "", profileLocationLabel: worker.profileLocationLabel ?? "", restrictedMapping: worker.hasRestrictedMapping, history: [] });
  }
  for (const row of mappings) {
    if (row.workforceId) continue;
    lookupEntries.push({ key: `provider:${providerMemberKey(row.stationId,row.providerMemberId)}`, stationId: row.stationId, stationLabel: row.stationLabel, workforceId: "", dropxId: "", fullName: "", providerMemberId: row.providerMemberId, providerMemberName: row.providerMemberName, profileLocationLabel: "", history: [] });
  }
  const shipmentMonths = [...new Set(providerMembers.filter((member) => stationByCode.has(member.stationCode.toUpperCase())).flatMap((member) => member.shipmentMonths))];
  const requestedStation = String(searchParams?.station ?? "").trim();
  const initialStationId = stations.find((station) => station.id === requestedStation || String(station.station_code ?? "").trim().toUpperCase() === requestedStation.toUpperCase())?.id ?? "";
  // Resolve current People ownership only for authorized stations represented
  // in this worksheet. An AOM is used only when that station has no cluster.
  const mappingStationIds = new Set(mappings.map((row) => row.stationId));
  const mappingStations = stations.filter((station) => mappingStationIds.has(station.id));
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, mappingStations.map((station) => station.id), { includeStationResponsibilities: true });
  const clusters = hierarchy.error ? null : nlPeopleClusters(mappingStations, hierarchy.byLocation);
  if (hierarchy.error) console.error("[provider-id-mapping] People cluster filter unavailable", { companyId, error: hierarchy.error });
  const clusterKeysByStation = Object.fromEntries([...(clusters?.byStation ?? [])].map(([id, value]) => [id, value.clusterKeys]));

  return <AppShell active="ID Mapping" pageCode={pageCode}>
    <PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" subtitle="Map provider members to available DropX workforce IDs and payment rates." />
    <nav className="performance-tabs" aria-label="ID mapping views"><Link className="active" href="/provider-id-mapping">Provider member first</Link><Link href="/provider-mapping/direct-pay">Direct pay allocations</Link></nav>

    {loadError ? <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">{loadError.message}</p></div></section> : null}
    {notice.error || notice.notice ? <section className={`panel message-panel ${notice.error ? "error" : "success"}`}><div className="panel-body"><strong>{notice.error ? "Action required" : "Completed"}</strong><p className="subtle">{notice.error ?? notice.notice}</p></div></section> : null}
    {!loadError ? <ProviderFirstMappingWorksheet clusterOptions={clusters?.options ?? []} clusterKeysByStation={clusterKeysByStation} clusterFilterUnavailable={Boolean(hierarchy.error)} lookupEntries={lookupEntries} initialOutboundMonth={entryFilters.month} initialMappingStatus={entryFilters.mapping} shipmentMonths={shipmentMonths} initialQuery={searchParams?.q} initialStationId={initialStationId} canEdit={canEdit} mappings={mappings} paymentMethods={paymentMethods} workers={workers} /> : null}
  </AppShell>;
}
