import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { saveProviderFirstMapping } from "@/app/provider-mapping/actions";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PageProps = { searchParams: Promise<{ q?: string; page?: string }> };

function flash() {
  const raw = cookies().get("dropx_provider_mapping_flash")?.value;
  try { return raw ? JSON.parse(raw) as { error?: string; notice?: string } : {}; } catch { return {}; }
}

export default async function ProviderFirstMappingPage({ searchParams }: PageProps) {
  const authorization = await requirePagePermission("provider_mapping", "access");
  const permission = authorization.permissions.provider_mapping;
  const companyId = requireCompanyId(authorization);
  const params = await searchParams;
  const query = String(params.q ?? "").trim().toLowerCase();
  const requestedPage = Math.max(1, Number(params.page ?? "1") || 1);
  const canEdit = Boolean(permission?.canAdd || permission?.canEdit);
  const hasAllLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const scopeIds = new Set(authorization.locationScopeIds);
  const permitted = (id: string | null) => hasAllLocations || Boolean(id && scopeIds.has(id));
  const notice = flash();

  if (!supabaseAdmin) {
    return <AppShell active="ID Mapping" pageCode="provider_mapping"><PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" /><section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Supabase service role key is not configured.</p></div></section></AppShell>;
  }

  const [stationsResult, workforceResult, providerRowsResult, mappingsResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id, station_code, station_name, provider_id").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, is_active").eq("company_id", companyId).is("deleted_at", null).eq("is_active", true).order("dropx_id"),
    supabaseAdmin.from("cps_shipment_daily").select("provider_employee_id, provider_employee_name, station_code, work_date").eq("company_id", companyId).order("work_date", { ascending: false }).limit(50000),
    supabaseAdmin.from("field_executive_provider_mappings").select("provider_member_id, workforce_id, effective_to, status").eq("company_id", companyId).is("effective_to", null).neq("status", "cancelled")
  ]);
  const loadError = stationsResult.error || workforceResult.error || providerRowsResult.error || mappingsResult.error;
  const stations = (stationsResult.data ?? []).filter((station) => permitted(station.id));
  const stationByCode = new Map(stations.map((station) => [station.station_code, station]));
  const workforce = (workforceResult.data ?? []).filter((worker) => permitted(worker.location_id) && worker.dropx_id).map((worker) => ({ id: worker.id, label: `${worker.dropx_id} — ${worker.full_name}`, locationId: worker.location_id }));
  const existingByMemberId = new Map((mappingsResult.data ?? []).map((mapping) => [String(mapping.provider_member_id), mapping.workforce_id]));
  const latestMembers = new Map<string, { id: string; name: string; stationId: string; stationLabel: string; mappedWorkforceId: string | null }>();
  for (const row of providerRowsResult.data ?? []) {
    const id = String(row.provider_employee_id ?? "").trim();
    const station = stationByCode.get(String(row.station_code ?? "").trim());
    if (!id || !station || latestMembers.has(id)) continue;
    latestMembers.set(id, { id, name: String(row.provider_employee_name ?? "").trim() || "Unnamed provider member", stationId: station.id, stationLabel: station.station_name ? `${station.station_code} - ${station.station_name}` : station.station_code, mappedWorkforceId: existingByMemberId.get(id) ?? null });
  }
  const members = Array.from(latestMembers.values()).filter((member) => !query || `${member.id} ${member.name} ${member.stationLabel}`.toLowerCase().includes(query));
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(members.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const visibleMembers = members.slice((page - 1) * pageSize, page * pageSize);
  const workforceById = new Map(workforce.map((worker) => [worker.id, worker.label]));

  return (
    <AppShell active="ID Mapping" pageCode="provider_mapping">
      <PageHead eyebrow="Source-of-truth bridge" title="ID & pay mapping" subtitle="Choose the mapping direction that suits the data you are working with." />
      <nav className="performance-tabs" aria-label="ID mapping views"><Link href="/provider-mapping">Existing worksheet</Link><Link className="active" href="/provider-mapping/provider-first">Provider member first</Link></nav>
      {loadError ? <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">{loadError.message}</p></div></section> : null}
      {notice.error || notice.notice ? <section className={`panel message-panel ${notice.error ? "error" : "success"}`}><div className="panel-body"><strong>{notice.error ? "Action required" : "Completed"}</strong><p className="subtle">{notice.error ?? notice.notice}</p></div></section> : null}
      {!loadError ? <section className="panel"><div className="panel-head"><div><h2>Provider member → workforce mapping</h2><p className="subtle">Start with an imported Provider Member ID, then select the matching workforce DropX ID. Existing worksheet and rate logic remain unchanged.</p></div></div>
        <form className="mapping-filters" method="get"><label className="mapping-filter-search">Search provider member<input defaultValue={params.q ?? ""} name="q" placeholder="Provider Member ID, name or location" type="search" /></label><button className="button secondary" type="submit">Search</button><span className="mapping-filter-summary">{members.length} provider members</span></form>
        <div className="table-wrap"><table><thead><tr><th>Provider Member ID</th><th>Provider Member Name</th><th>Location</th><th>Current link</th><th>Link to workforce DropX ID</th></tr></thead><tbody>{visibleMembers.map((member) => <tr key={member.id}><td className="mono">{member.id}</td><td>{member.name}</td><td>{member.stationLabel}</td><td>{member.mappedWorkforceId ? workforceById.get(member.mappedWorkforceId) ?? "Mapped workforce not in your scope" : "Unlinked"}</td><td><form action={saveProviderFirstMapping}><input name="provider_member_id" type="hidden" value={member.id} /><input name="station_id" type="hidden" value={member.stationId} /><select defaultValue={member.mappedWorkforceId ?? ""} disabled={!canEdit} name="workforce_id" required><option value="">Select DropX ID</option>{workforce.filter((worker) => worker.locationId === member.stationId).map((worker) => <option key={worker.id} value={worker.id}>{worker.label}</option>)}</select><button className="button compact" disabled={!canEdit} type="submit">Save link</button></form></td></tr>)}</tbody></table></div>
        <div className="mapping-pagination"><span>Showing {(page - 1) * pageSize + (visibleMembers.length ? 1 : 0)}–{Math.min(page * pageSize, members.length)} of {members.length}</span><div className="mapping-pagination-actions"><Link className="button secondary compact" href={`/provider-mapping/provider-first?q=${encodeURIComponent(params.q ?? "")}&page=${Math.max(1, page - 1)}`}>Previous</Link><span>Page {page} of {totalPages}</span><Link className="button secondary compact" href={`/provider-mapping/provider-first?q=${encodeURIComponent(params.q ?? "")}&page=${Math.min(totalPages, page + 1)}`}>Next</Link></div></div>
      </section> : null}
    </AppShell>
  );
}