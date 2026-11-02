
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { NetworkPlanningWorkspace } from "@/components/network-planning-workspace";
import { ServiceNetworkMap } from "@/components/service-network-map";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCapacityPincodes } from "@/lib/ops-pulse/capacity-shipments";
import { loadCapacityRegionMaps, loadGoogleMyMapsStationLayer } from "@/lib/ops-pulse/capacity";
import { inferFormTypeFromLocation, loadCodLocations, locationModelName, providerName } from "@/lib/ops-pulse/cod";
import { loadNetworkPlanning, startOfPlanningWeek } from "@/lib/ops-pulse/network-planning";
import { capacityForMix, loadServiceNetworkRules } from "@/lib/ops-pulse/service-network";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
type Search = { station?: string; client?: string; from?: string; to?: string; week?: string; date?: string; view?: string; notice?: string; error?: string };
function day(offset = 0) { const date = new Date(); date.setDate(date.getDate() + offset); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date); }
function validDate(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function number(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }
function clientName(location: Parameters<typeof inferFormTypeFromLocation>[0]) { const type = inferFormTypeFromLocation(location); return type === "amazon" ? "Amazon EDSP" : type === "flipkart" ? `Flipkart ${locationModelName(location) || "ODH/MDH"}` : "Other"; }

export default async function ServiceNetworkPage({ searchParams }: { searchParams?: Search }) {
  const authorization = await requirePagePermission("service_network", "access");
  const companyId = requireCompanyId(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const eligible = locationResult.locations.filter(location => ["amazon", "flipkart"].includes(inferFormTypeFromLocation(location)));
  const client = ["amazon", "flipkart"].includes(String(searchParams?.client)) ? String(searchParams?.client) : "amazon";
  const clientLocations = eligible.filter(location => inferFormTypeFromLocation(location) === client);
  const selected = clientLocations.find(location => location.station_code === String(searchParams?.station ?? "").toUpperCase()) ?? clientLocations[0] ?? eligible[0] ?? null;
  const to = validDate(searchParams?.to) ? String(searchParams?.to) : day(-1);
  const from = validDate(searchParams?.from) ? String(searchParams?.from) : day(-7);
  const [rulesResult, mapsResult, pincodeResult, stationResult] = selected ? await Promise.all([
    loadServiceNetworkRules(companyId),
    loadCapacityRegionMaps(companyId),
    loadCapacityPincodes(companyId, selected.station_code, from, to),
    supabaseAdmin ? supabaseAdmin.from("stations").select("latitude,longitude,address,postal_code")
      .eq("company_id", companyId).eq("station_code", selected.station_code).maybeSingle() : { data: null, error: { message: "Database service is unavailable." } }
  ]) : [{ rows: [], error: null }, { rows: [], error: null }, { data: [], error: null }, { data: null, error: null }];
  const rule = rulesResult.rows.find(row => row.stationCode === selected?.station_code && row.isActive);
  const today = day();
  const week = startOfPlanningWeek(validDate(searchParams?.week) ? String(searchParams?.week) : today);
  const weekEndDate = new Date(`${week}T00:00:00Z`); weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);
  const requestedPlanDate = validDate(searchParams?.date) ? String(searchParams?.date) : today;
  const planDate = requestedPlanDate >= week && requestedPlanDate <= weekEnd ? requestedPlanDate : week;
  const planningView = ["control", "routes", "roster"].includes(String(searchParams?.view)) ? String(searchParams?.view) as "control" | "routes" | "roster" : "control";
  const planning = selected ? await loadNetworkPlanning({ companyId, stationId: selected.id, weekStart: week, selectedDate: planDate, rule }) : null;
  const normalized = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const map = selected ? mapsResult.rows.find(row => normalized(row.matchValue) === normalized(row.matchField === "station" ? selected.station_code : row.matchField === "state" ? selected.state : selected.region)) : null;
  const layer = selected && map ? await loadGoogleMyMapsStationLayer(companyId, map.mapUrl, selected.station_code) : { features: [], error: selected ? "No jurisdiction map is configured for this station." : null };
  const pincodeFromName = (value: string) => value.match(/(?:^|\D)([1-9]\d{5})(?:\D|$)/)?.[1] ?? null;
  const normalizedLayerFeatures = layer.features.map(feature => ({ ...feature, name: pincodeFromName(feature.name) ?? feature.name }));
  const coordinateFeatures = Object.entries(rule?.pincodeCoordinates ?? {}).map(([name, point]) => ({ name, coordinates: [point] }));
  const mappedPincodes = new Set(normalizedLayerFeatures.filter(feature => /^\d{6}$/.test(feature.name)).map(feature => feature.name));
  const mapFeatures = [...normalizedLayerFeatures, ...coordinateFeatures.filter(feature => !mappedPincodes.has(feature.name))];
  const rows = pincodeResult.data ?? [];
  const periodDays = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1);
  const metrics = rows.map(row => { const mix = capacityForMix({ small: number(row.small), volumetric: number(row.volumetric), rule }); return { pincode: row.postal_code, delivered: number(row.delivered), volumetric: number(row.volumetric), small: number(row.small), activeIds: number(row.active_ids), bike: mix.bike, van: mix.van, totalRequired: mix.total, activeDays: number(row.active_days), unclassified: number(row.unclassified) }; });
  const delivered = metrics.reduce((sum, row) => sum + row.delivered, 0), volumetric = metrics.reduce((sum, row) => sum + row.volumetric, 0), small = metrics.reduce((sum, row) => sum + row.small, 0), unclassified = metrics.reduce((sum, row) => sum + row.unclassified, 0);
  const detected = new Set(metrics.map(row => row.pincode));
  const approved = new Set([...(rule?.pincodeOwnership ?? []), ...mapFeatures.filter(feature => /^\d{6}$/.test(feature.name)).map(feature => feature.name)]);
  const outside = [...detected].filter(code => approved.size && !approved.has(code));
  const noDemand = [...approved].filter(code => !detected.has(code));
  const stationLat = number(stationResult.data?.latitude), stationLng = number(stationResult.data?.longitude);
  const sourceError = locationResult.error || rulesResult.error || mapsResult.error || pincodeResult.error?.message || stationResult.error?.message;

  return <AppShell active="Network Planning" pageCode="service_network"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Service Network" title="Network Planning" subtitle="Plan confirmed station sectors, routes, Field Executives, capacity and daily exceptions in one operational workspace." action={<a className="button secondary compact" href="/ops-pulse/master/service-network">Network Planning Master</a>} />
    <form className="capacity-station-toolbar" method="get"><label>Client<select name="client" defaultValue={client}><option value="amazon">Amazon EDSP</option><option value="flipkart">Flipkart ODH / MDH</option></select></label><label>Station<select name="station" defaultValue={selected?.station_code}>{clientLocations.map(location => <option key={location.id} value={location.station_code}>{location.station_code} · {location.station_name || location.city || "Station"}</option>)}</select></label><label>From<input type="date" name="from" defaultValue={from}/></label><label>To<input type="date" name="to" defaultValue={to}/></label><button className="button compact">Apply</button></form>
    {sourceError || searchParams?.error ? <div className="message-panel error">{searchParams?.error || sourceError}</div> : null}{searchParams?.notice ? <div className="message-panel success">{searchParams.notice}</div> : null}
    {!selected ? <section className="panel"><div className="empty-cell">No Amazon EDSP or Flipkart ODH/MDH station is available in your jurisdiction.</div></section> : <>
      <div className="capacity-action-line"><strong>Jurisdiction</strong><span>{[selected.region, selected.aom, selected.cluster, selected.station_code].filter(Boolean).join(" › ") || selected.station_code} · {clientName(selected)} · {providerName(selected)} · rolling 7 complete days</span></div>
      <section className="performance-summary-grid"><article><span>Delivered volume</span><strong>{fmt(delivered)}</strong><small>{fmt(delivered / periodDays, 1)} average/day</small></article><article><span>Volumetric mix</span><strong>{delivered ? `${fmt(volumetric / delivered * 100, 1)}%` : "—"}</strong><small>{fmt(volumetric)} shipments</small></article><article><span>Small mix</span><strong>{delivered ? `${fmt(small / delivered * 100, 1)}%` : "—"}</strong><small>{fmt(small)} shipments</small></article><article><span>Service pincodes</span><strong>{approved.size || detected.size}</strong><small>{outside.length ? `${outside.length} outside jurisdiction` : "No boundary conflict"}</small></article><article><span>Classification gap</span><strong>{fmt(unclassified)}</strong><small>{delivered ? `${fmt(unclassified / delivered * 100, 1)}% of volume` : "No volume"}</small></article></section>
      {planning ? <NetworkPlanningWorkspace data={planning} stationId={selected.id} stationCode={selected.station_code} client={client} from={from} to={to} week={week} selectedDate={planDate} view={planningView} canEdit={authorization.permissions.service_network.canEdit}/> : null}
      <ServiceNetworkMap station={stationLat && stationLng ? { code: selected.station_code, lat: stationLat, lng: stationLng } : null} features={mapFeatures} metrics={metrics} radiusKm={rule?.serviceRadiusKm ?? null} sectors={(planning?.sectors ?? []).map(sector => ({ name: sector.name, color: sector.color, pincodes: sector.pincodes.map(item => item.pincode) }))}/>
      {layer.error ? <div className="capacity-source-gap"><strong>Boundary action required</strong><span>{layer.error} Add the approved KML/My Maps source in Capacity Master, then define this station’s jurisdiction rule.</span></div> : null}
      <section className="panel"><div className="panel-head"><div><h2>Pincode capacity plan</h2><p className="subtle">Seven-day volume and serving-DA evidence. Select volume or IDs to inspect shipment and associate detail.</p></div><span className="status-pill neutral">{from.split("-").reverse().join("/")} – {to.split("-").reverse().join("/")}</span></div><div className="table-wrap"><ReportTable className="capacity-daily-table"><thead><tr><th>Pincode</th><th>Delivered</th><th>Avg/day</th><th>Share</th><th>Serving DAs</th><th>Volumetric</th><th>Small</th><th>Bike required</th><th>Van required</th><th>Signal</th></tr></thead><tbody>{metrics.sort((a,b) => b.delivered-a.delivered).map(row => { const conflict = approved.size > 0 && !approved.has(row.pincode); const gap = row.totalRequired == null ? null : row.totalRequired - row.activeIds; const detail = `/ops-pulse/capacity/shipments?station=${selected.station_code}&pincode=${row.pincode}&from=${from}&to=${to}`; return <tr key={row.pincode}><td><strong>{row.pincode}</strong>{conflict ? <small className="metric-bad-text">Outside jurisdiction</small> : null}</td><td><a href={detail}>{fmt(row.delivered)}</a></td><td>{fmt(row.delivered / Math.max(1,row.activeDays),1)}</td><td>{delivered ? `${fmt(row.delivered/delivered*100,1)}%` : "—"}</td><td><a href={detail}>{row.activeIds} DAs</a></td><td><a href={`${detail}&size=volumetric`}>{fmt(row.volumetric)} · {row.delivered ? fmt(row.volumetric/row.delivered*100,1) : 0}%</a></td><td><a href={`${detail}&size=small`}>{fmt(row.small)} · {row.delivered ? fmt(row.small/row.delivered*100,1) : 0}%</a></td><td>{row.bike ?? "Configure"}</td><td>{row.van ?? "Configure"}</td><td><span className={`status-pill ${conflict || (gap != null && gap > 0) ? "bad" : gap == null ? "neutral" : "good"}`}>{conflict ? "Boundary conflict" : gap == null ? "Rule missing" : gap > 0 ? `Need ${gap}` : "Covered"}</span></td></tr>; })}{!metrics.length ? <tr><td className="empty-cell" colSpan={10}>No pincode shipment facts are available for this station and period.</td></tr> : null}</tbody></ReportTable></div></section>
      {(outside.length || noDemand.length) ? <section className="panel"><div className="panel-head"><div><h2>Jurisdiction exceptions</h2><p className="subtle">Resolve boundaries before using these pincodes for hiring decisions.</p></div></div><div className="panel-body compact-summary-grid"><div><span className="subtle">Demand outside boundary</span><strong>{outside.join(", ") || "None"}</strong></div><div><span className="subtle">Approved without demand</span><strong>{noDemand.join(", ") || "None"}</strong></div></div></section> : null}
    </>}
  </div></AppShell>;
}
