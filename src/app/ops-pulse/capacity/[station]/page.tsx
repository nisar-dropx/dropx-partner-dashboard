
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { CapacityServiceMap } from "@/components/capacity-service-map";
import { CapacityStationLayerMap } from "@/components/capacity-station-layer-map";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import { loadApprovedCapacityAdHocUsage } from "@/lib/ops-pulse/capacity-ad-hoc";
import { capacityMapEmbedUrl, loadCapacityRegionMaps, loadCapacityRules, loadCapacityServiceRoutes, loadGoogleMyMapsStationLayer, loadShipmentSizeRule } from "@/lib/ops-pulse/capacity";
import { buildCapacityPlanningDecision } from "@/lib/ops-pulse/capacity-decision";
import { loadCapacityAssociateDays, loadCapacityPincodes, loadCapacityStationDays } from "@/lib/ops-pulse/capacity-shipments";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { associateIdentityKey } from "@/lib/ops-pulse/associate-identity";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type SearchParams = { from?: string; to?: string; error?: string; service?: string };
type RateCardRow = { id: string; name: string; pay_type: string | null; status: string; effective_from: string; effective_to: string | null; rate_card_lines?: Array<{ metric_code: string; rate: number | string; unit: string | null }> | null };
type StationMapRow = { latitude: number | string | null; longitude: number | string | null; postal_code: string | null; address: string | null };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function yesterday() { const date = new Date(`${today()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
function validDate(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function num(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }

export default async function CapacityStationPage({ params, searchParams }: { params: { station: string }; searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_overview", "access");
  const companyId = requireCompanyId(authorization);
  const workspaceTabs = allowedCapacityWorkspaceTabs(authorization);
  const stationCode = decodeURIComponent(params.station).trim().toUpperCase();
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const location = locationResult.locations.find((entry) => entry.station_code === stationCode);
  if (!location) notFound();
  const end = validDate(searchParams?.to) ? String(searchParams?.to) : yesterday();
  const start = validDate(searchParams?.from) ? String(searchParams?.from) : `${end.slice(0, 8)}01`;
  const showService = searchParams?.service === "1";
  const [stationDailyResult, associateResult, pincodeResult, ruleResult, sizeResult, adHocResult, stationMapResult, rateCardResult, capacityMapResult, serviceRouteResult] = await Promise.all([
    loadCapacityStationDays(companyId, [stationCode], start, end),
    loadCapacityAssociateDays(companyId, [stationCode], start, end),
    showService ? loadCapacityPincodes(companyId, stationCode, start, end) : { data: [], error: null },
    loadCapacityRules(companyId),
    loadShipmentSizeRule(companyId),
    loadApprovedCapacityAdHocUsage(companyId, start, end),
    showService && supabaseAdmin ? supabaseAdmin.from("stations").select("latitude,longitude,postal_code,address")
      .eq("company_id", companyId).eq("station_code", stationCode).maybeSingle()
      : { data: null as StationMapRow | null, error: null },
    showService && supabaseAdmin ? supabaseAdmin.from("rate_cards").select("id,name,pay_type,status,effective_from,effective_to,rate_card_lines(metric_code,rate,unit)")
      .eq("station_id", location.id).in("status", ["active", "approved"]).order("effective_from", { ascending: false }).limit(10)
      : { data: [] as RateCardRow[], error: null },
    showService ? loadCapacityRegionMaps(companyId) : { rows: [], error: null },
    showService ? loadCapacityServiceRoutes(companyId, stationCode) : { rows: [], error: null }
  ]);
  const rows = associateResult.data ?? [];
  const rule = ruleResult.rows.find((entry) => entry.stationCode === stationCode);
  const planning = buildCapacityPlanningDecision({
    stationCode,
    rows: stationDailyResult.data ?? [],
    adHocUsage: adHocResult.rows,
    rule
  });
  const daily = planning.daily.map((day) => ({
    date: day.date,
    ids: day.systemIds,
    internalDAs: day.internalDAs,
    externalDAs: day.externalDAs,
    paymentRequests: day.paymentRequests,
    delivered: day.workload,
    inbound: day.inbound,
    source: day.source,
    spr: day.spr
  }));
  const minimumActive = sizeResult.rule?.minActiveShipments ?? 5;
  const targetSpr = rule?.targetSpr ?? null;
  const buffer = rule?.bufferPercent ?? 0;
  const totalDelivered = daily.reduce((sum, day) => sum + day.delivered, 0);
  const averageIds = daily.length ? daily.reduce((sum, day) => sum + day.ids, 0) / daily.length : 0;
  const averageVolume = daily.length ? totalDelivered / daily.length : 0;
  const averageInbound = daily.length ? daily.reduce((sum, day) => sum + day.inbound, 0) / daily.length : 0;
  const averageSpr = averageIds ? averageVolume / averageIds : 0;
  const requiredIds = targetSpr && averageVolume ? Math.ceil(averageVolume / targetSpr * (1 + buffer / 100)) : null;
  const identityKeys = [...new Set(rows.filter((row) => row.associate_id).map((row) => associateIdentityKey(stationCode, row.associate_id, row.associate_name)))];
  const allocations = identityKeys.map((identityKey) => {
    const idRows = rows.filter((row) => associateIdentityKey(stationCode, row.associate_id, row.associate_name) === identityKey);
    const id = idRows[0]?.associate_id ?? "";
    const workedDates = [...new Set(idRows.filter((row) => num(row.delivered) >= minimumActive).map((row) => row.work_date))];
    const lowVolumeDays = idRows.filter((row) => num(row.delivered) < minimumActive).length;
    const delivered = idRows.reduce((sum, row) => sum + num(row.delivered), 0);
    const volumetric = idRows.reduce((sum, row) => sum + num(row.volumetric), 0);
    const small = idRows.reduce((sum, row) => sum + num(row.small), 0);
    const activeDelivered = idRows.filter((row) => num(row.delivered) >= minimumActive).reduce((sum, row) => sum + num(row.delivered), 0);
    return { identityKey, id, name: idRows.find((row) => row.associate_name)?.associate_name || "Unmapped name", days: workedDates.length, lowVolumeDays, delivered, volumetric, small, average: workedDates.length ? activeDelivered / workedDates.length : 0 };
  }).sort((a, b) => b.average - a.average);
  const averageInternalDAs = daily.length ? daily.reduce((sum, day) => sum + day.internalDAs, 0) / daily.length : 0;
  const averageExternalDAs = daily.length ? daily.reduce((sum, day) => sum + day.externalDAs, 0) / daily.length : 0;
  const adHocDays = daily.filter((day) => day.externalDAs > 0).length;
  const approvedRequests = daily.reduce((sum, day) => sum + day.paymentRequests, 0);
  const stationMap = stationMapResult.data as StationMapRow | null;
  const latitude = num(stationMap?.latitude);
  const longitude = num(stationMap?.longitude);
  const rateCards = (rateCardResult.data ?? []) as unknown as RateCardRow[];
  const pincodes = pincodeResult.data ?? [];
  const pincodeDelivered = pincodes.reduce((sum, row) => sum + num(row.delivered), 0);
  const weightReady = pincodes.reduce((sum, row) => sum + num(row.weight_ready), 0);
  const dimensionReady = pincodes.reduce((sum, row) => sum + num(row.dimension_ready), 0);
  const normalized = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
  const capacityMap = capacityMapResult.rows.find((map) => normalized(map.matchValue) === normalized(
    map.matchField === "station" ? stationCode : map.matchField === "state" ? location.state : location.region
  ));
  const capacityMapUrl = capacityMap ? capacityMapEmbedUrl(capacityMap.mapUrl) : null;
  const stationLayer = showService && capacityMap ? await loadGoogleMyMapsStationLayer(companyId, capacityMap.mapUrl, stationCode) : { features: [], error: null };
  const action = planning.action;

  return <AppShell active="Capacity" pageCode="capacity_overview"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Station Capacity" title={`${stationCode} · ${location.station_name || location.city || stationCode}`} subtitle="Road-ID headcount, capacity workload, inbound demand and allocation productivity." />
    <CapacityWorkspaceTabs active="overview" allowed={workspaceTabs} />
    <div className="capacity-station-toolbar"><a className="button secondary compact" href="/ops-pulse/capacity">← All stations</a><form method="get"><label>From<input type="date" name="from" defaultValue={start}/></label><label>To<input type="date" name="to" defaultValue={end}/></label><button className="button compact">Apply</button></form></div>
    {searchParams?.error || stationDailyResult.error || associateResult.error || pincodeResult.error || adHocResult.error || stationMapResult.error || rateCardResult.error || capacityMapResult.error || serviceRouteResult.error ? <div className="message-panel error">{searchParams?.error || stationDailyResult.error?.message || associateResult.error?.message || pincodeResult.error?.message || adHocResult.error || stationMapResult.error?.message || rateCardResult.error?.message || capacityMapResult.error || serviceRouteResult.error}</div> : null}
    <section className="performance-summary-grid"><article><span>Average road IDs</span><strong>{fmt(averageIds, 1)}</strong><small>Daily active IDs</small></article><article><span>Average workload</span><strong>{fmt(averageVolume)}</strong><small>Amazon + SMD + SWA + C-return</small></article><article><span>Average inbound</span><strong>{averageInbound ? fmt(averageInbound) : "—"}</strong><small>Expected packages at station</small></article><article><span>Average SPR</span><strong>{fmt(averageSpr, 1)}</strong><small>Workload ÷ road-active IDs</small></article><article><span>Required IDs</span><strong>{requiredIds ?? "—"}</strong><small>{targetSpr ? `SPR ${fmt(targetSpr, 1)} + ${fmt(buffer)}% buffer` : "Configure master"}</small></article></section>
    <section className="performance-summary-grid capacity-actual-summary"><article><span>Internal DAs</span><strong>{daily.length ? fmt(averageInternalDAs, 1) : "—"}</strong><small>Amazon IDs used minus external DA replacements</small></article><article><span>External DAs</span><strong>{daily.length ? fmt(averageExternalDAs, 1) : "—"}</strong><small>Approved replacements using existing Amazon IDs</small></article><article><span>External-cover days</span><strong>{adHocDays}/{daily.length}</strong><small>Days with approved external DAs</small></article><article><span>Approved requests</span><strong>{approvedRequests}</strong><small>Included in selected period</small></article></section>
    <div className="capacity-action-line"><strong>Action</strong><span>{action}</span></div>
    <section className="panel"><div className="panel-head"><div><h2>Day-level capacity</h2><p className="subtle">Amazon IDs stay unchanged. Approved payment requests identify which existing IDs were operated by external DAs.</p></div></div><div className="table-wrap"><ReportTable className="capacity-daily-table"><thead><tr><th>Date</th><th>Amazon IDs used</th><th>Internal DAs</th><th>External DAs</th><th>Approved requests</th><th>Workload</th><th>Inbound</th><th>SPR</th></tr></thead><tbody>
      {daily.map((day) => <tr key={day.date}><td>{day.date.split("-").reverse().join("/")}</td><td><strong>{day.ids}</strong></td><td>{day.internalDAs}</td><td><strong className={day.externalDAs ? "metric-warn-text" : ""}>{day.externalDAs}</strong></td><td>{day.paymentRequests || "—"}</td><td>{fmt(day.delivered)}</td><td>{day.inbound ? fmt(day.inbound) : "—"}</td><td><strong>{fmt(day.spr, 1)}</strong></td></tr>)}
      {!daily.length ? <tr><td className="empty-cell" colSpan={8}>No capacity source data in this range.</td></tr> : null}
    </tbody></ReportTable></div></section>
    <section className="panel"><div className="panel-head"><div><h2>Associate allocation</h2><p className="subtle">Active days require at least {minimumActive} workload. Select a size count to inspect its tracking IDs.</p></div><a className="button secondary compact" href={`/ops-pulse/capacity/associates?station=${stationCode}&from=${start}&to=${end}&preset=custom`}>Open full SPR view</a></div><div className="table-wrap"><ReportTable className="capacity-daily-table"><thead><tr><th>Associate</th><th>Active days</th><th>Low-volume days</th><th>Workload</th><th>Average/day</th><th>Volumetric</th><th>Small</th><th>Workload position</th></tr></thead><tbody>{allocations.map((row) => <tr key={row.identityKey}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/associates/${encodeURIComponent(row.id)}?station=${stationCode}&from=${start}&to=${end}&name=${encodeURIComponent(row.name)}`}><strong>{row.name}</strong><small>{row.id}</small></a></td><td>{row.days}</td><td><span className={row.lowVolumeDays ? "metric-bad-text" : ""}>{row.lowVolumeDays || "—"}</span></td><td>{fmt(row.delivered)}</td><td><strong className={row.average > (rule?.maxSafeSpr ?? 70) ? "metric-bad-text" : ""}>{fmt(row.average, 1)}</strong></td><td><a href={`/ops-pulse/capacity/shipments?station=${stationCode}&associate=${encodeURIComponent(row.id)}&size=volumetric&from=${start}&to=${end}`}>{fmt(row.volumetric)} · {row.delivered ? `${fmt(row.volumetric / row.delivered * 100, 1)}%` : "—"}</a></td><td><a href={`/ops-pulse/capacity/shipments?station=${stationCode}&associate=${encodeURIComponent(row.id)}&size=small&from=${start}&to=${end}`}>{fmt(row.small)} · {row.delivered ? `${fmt(row.small / row.delivered * 100, 1)}%` : "—"}</a></td><td><span className={`capacity-decision ${row.average > (rule?.maxSafeSpr ?? 70) ? "risk" : row.average < (rule?.targetSpr ?? 60) ? "unconfigured" : "balanced"}`}>{row.average > (rule?.maxSafeSpr ?? 70) ? "Above safe" : row.average < (rule?.targetSpr ?? 60) ? "Below target" : "Target range"}</span></td></tr>)}</tbody></ReportTable></div></section>
    {showService ? <><section className="panel capacity-area-pay"><div className="panel-head"><div><h2>Service-area intelligence</h2><p className="subtle">Use the approved map for service boundaries and the pincode table for actionable volume and ID demand.</p></div><a className="button secondary compact" href="/master/capacity">Manage map data</a></div>
      <div className="capacity-area-grid"><div className="capacity-map-card">
      {stationLayer.features.length ? <CapacityStationLayerMap stationCode={stationCode} features={stationLayer.features}/> : capacityMapUrl ? <iframe title={capacityMap?.name || `${stationCode} service-area map`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" src={capacityMapUrl}/> : latitude && longitude ? <iframe title={`${stationCode} station map`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" src={`https://www.google.com/maps?q=${latitude},${longitude}&z=12&output=embed`}/> : <div className="capacity-map-empty"><strong>Map not configured</strong><span>Add a station or region map in Capacity Master.</span></div>}
      <div className="capacity-map-meta"><strong>{capacityMap?.name || `${stationCode} service area`}</strong><span>{stationMap?.address || location.city || "Station coordinates not configured"}</span>{capacityMap ? <a href={capacityMap.mapUrl} target="_blank" rel="noreferrer">Open full map</a> : null}</div>
      </div>
      <div className="capacity-rate-list">{rateCards.flatMap((card) => (card.rate_card_lines ?? []).map((line) => <article key={`${card.id}-${line.metric_code}`}><div><strong>{line.metric_code.replace(/_/g, " ")}</strong><span>{card.name} · {card.pay_type || "Pay type not set"}</span></div><b>₹{fmt(num(line.rate), 2)} {line.unit || ""}</b></article>))}{!rateCards.length ? <div className="capacity-map-empty"><strong>No approved station rate card</strong><span>Configure bike/van and delivery rates before the hiring team uses pay guidance.</span></div> : null}<div className="capacity-source-gap"><strong>{pincodes.length} delivery pincodes detected</strong><span>{pincodeDelivered ? `${fmt(pincodeDelivered)} shipments mapped by pincode. ` : ""}{weightReady ? `${fmt(weightReady)} have weight; ` : ""}{dimensionReady ? `${fmt(dimensionReady)} have complete dimensions. ` : ""}Vehicle type is not present in the source, so bike/van capacity still requires an Area Capacity Master.</span></div></div>
    </div>{serviceRouteResult.rows.length ? <CapacityServiceMap routes={serviceRouteResult.rows} station={latitude && longitude ? { lat: latitude, lng: longitude, label: stationCode } : null}/> : null}</section>
    <section className="panel"><div className="panel-head"><div><h2>Service-area demand</h2><p className="subtle">Action view: volume concentration, serving IDs and shipment-size mix. Select a count to inspect tracking IDs.</p></div><span className="status-pill neutral">{pincodes.length} pincodes</span></div><div className="table-wrap"><ReportTable className="capacity-daily-table"><thead><tr><th>Pincode</th><th>Delivered</th><th>Station share</th><th>Serving IDs</th><th>Volumetric</th><th>Small</th><th>Unclassified</th></tr></thead><tbody>{pincodes.slice(0, 25).map((row) => <tr key={row.postal_code}><td><strong>{row.postal_code}</strong></td><td><a href={`/ops-pulse/capacity/shipments?station=${stationCode}&pincode=${row.postal_code}&from=${start}&to=${end}`}>{fmt(num(row.delivered))}</a></td><td>{pincodeDelivered ? `${fmt(num(row.delivered) / pincodeDelivered * 100, 1)}%` : "—"}</td><td>{fmt(num(row.active_ids))}</td><td><a href={`/ops-pulse/capacity/shipments?station=${stationCode}&pincode=${row.postal_code}&size=volumetric&from=${start}&to=${end}`}>{fmt(num(row.volumetric))} · {num(row.delivered) ? `${fmt(num(row.volumetric) / num(row.delivered) * 100, 1)}%` : "—"}</a></td><td><a href={`/ops-pulse/capacity/shipments?station=${stationCode}&pincode=${row.postal_code}&size=small&from=${start}&to=${end}`}>{fmt(num(row.small))} · {num(row.delivered) ? `${fmt(num(row.small) / num(row.delivered) * 100, 1)}%` : "—"}</a></td><td className={num(row.unclassified) ? "metric-bad-text" : ""}>{fmt(num(row.unclassified))}</td></tr>)}{!pincodes.length ? <tr><td className="empty-cell" colSpan={7}>No pincode-level shipment facts are available for this range.</td></tr> : null}</tbody></ReportTable></div></section></> : <section className="panel capacity-lazy-section"><div><span>Optional detail</span><h2>Service area, rates and pincode demand</h2><p>Load maps and shipment-level service-area evidence only when needed.</p></div><a className="button secondary" href={`/ops-pulse/capacity/${stationCode}?from=${start}&to=${end}&service=1`}>Load service detail</a></section>}
  </div></AppShell>;
}
