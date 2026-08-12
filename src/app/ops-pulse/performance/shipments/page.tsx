import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { CapacityScopeFilter } from "@/components/capacity-scope-filter";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  loadCapacityDeliveryBreakdown,
  loadCapacityPincodes,
  type CapacityPincode,
  type CapacityDeliveryBreakdown
} from "@/lib/ops-pulse/capacity-shipments";
import {
  summarizeAmazonDeliveryRows,
  totalAmazonDeliveryRows,
  type AmazonDeliveryTotals
} from "@/lib/ops-pulse/delivery-source";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";

export const dynamic = "force-dynamic";

type SearchParams = { from?: string; to?: string; station?: string; stations?: string; day?: string; sort?: string; dir?: string };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function validDate(value: unknown, fallback: string) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : fallback; }
function num(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }
function scopeCodes(value: string | undefined, allowed: string[]) {
  if (!value) return allowed;
  if (value === "_none") return [];
  const requested = value.split(",").map((code) => code.trim().toUpperCase());
  return allowed.filter((code) => requested.includes(code));
}
export default async function DeliveryDataPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cps_shipments", "access");
  const companyId = requireCompanyId(authorization);
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationsResult.locations.filter(isAmazonEdspXptLocation);
  const codes = scopeCodes(searchParams?.stations, locations.map((location) => location.station_code));
  const selectedStation = locations.some((location) => location.station_code === String(searchParams?.station ?? "").toUpperCase()) ? String(searchParams?.station).toUpperCase() : "";
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(searchParams?.day ?? "")) ? String(searchParams?.day) : "";
  const to = validDate(searchParams?.to, today());
  const from = validDate(searchParams?.from, `${to.slice(0, 7)}-01`);
  const sort = ["code", "workload", "activeIds", "days", "average", "spr"].includes(String(searchParams?.sort)) ? String(searchParams?.sort) : "workload";
  const dir = searchParams?.dir === "asc" ? "asc" : "desc";
  const deliveryCodes = selectedStation ? [selectedStation] : codes;
  const pincodeFrom = selectedDay || from;
  const pincodeTo = selectedDay || to;
  const [breakdownResult, pincodeResult] = await Promise.all([
    loadCapacityDeliveryBreakdown(companyId, deliveryCodes, from, to),
    selectedStation
      ? loadCapacityPincodes(companyId, selectedStation, pincodeFrom, pincodeTo)
      : Promise.resolve({ data: [] as CapacityPincode[], error: null })
  ]);
  const breakdown = breakdownResult.data ?? [];
  const pincodes = pincodeResult.data ?? [];
  const daily = summarizeAmazonDeliveryRows(breakdown);
  const locationMap = new Map(locations.map((location) => [location.station_code, location]));
  const stationRows = codes.map((code) => {
    const rows = daily.filter((row) => row.stationCode === code);
    const workload = rows.reduce((sum, row) => sum + row.totals.workload, 0);
    const activeIds = Math.max(0, ...rows.map((row) => row.activeIds));
    const average = rows.length ? workload / rows.length : 0;
    const averageIds = rows.length ? rows.reduce((sum, row) => sum + row.activeIds, 0) / rows.length : 0;
    return { code, name: locationMap.get(code)?.station_name || locationMap.get(code)?.city || code, workload, activeIds, days: rows.length, average, spr: averageIds ? average / averageIds : 0 };
  }).filter((row) => row.days);
  const sortValue = (row: typeof stationRows[number]) => sort === "code" ? row.code : num(row[sort as keyof typeof row]);
  stationRows.sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    const compared = typeof left === "string" ? left.localeCompare(String(right)) : left - Number(right);
    return compared * (dir === "asc" ? 1 : -1);
  });

  const stationDaily = selectedStation
    ? daily.filter((row) => row.stationCode === selectedStation)
      .sort((a, b) => b.workDate.localeCompare(a.workDate))
    : [];
  const stationBreakdown = selectedStation ? breakdown.filter((row) => row.station_code === selectedStation) : breakdown;
  const selectedBreakdown = selectedDay ? stationBreakdown.filter((row) => row.work_date === selectedDay) : stationBreakdown;
  const selectedTotals: AmazonDeliveryTotals = totalAmazonDeliveryRows(selectedBreakdown);
  const associateMap = new Map<string, CapacityDeliveryBreakdown>();
  if (selectedStation && selectedDay) {
    selectedBreakdown.forEach((row) => {
      const current = associateMap.get(row.provider_employee_id);
      if (!current) {
        associateMap.set(row.provider_employee_id, { ...row });
        return;
      }
      current.amazon_delivery = num(current.amazon_delivery) + num(row.amazon_delivery);
      current.base_amazon_delivery = num(current.base_amazon_delivery) + num(row.base_amazon_delivery);
      current.swa_delivery = num(current.swa_delivery) + num(row.swa_delivery);
      current.c_return = num(current.c_return) + num(row.c_return);
      current.mfn = num(current.mfn) + num(row.mfn);
      current.mfn_return = num(current.mfn_return) + num(row.mfn_return);
      current.smd_delivery += num(row.smd_delivery);
      current.smd2_delivery += num(row.smd2_delivery);
      if (!current.provider_employee_name && row.provider_employee_name) current.provider_employee_name = row.provider_employee_name;
    });
  }
  const dayAssociates = [...associateMap.values()].sort((a, b) =>
    (num(b.base_amazon_delivery) + num(b.smd_delivery) + num(b.smd2_delivery) + num(b.swa_delivery) + num(b.c_return))
    - (num(a.base_amazon_delivery) + num(a.smd_delivery) + num(a.smd2_delivery) + num(a.swa_delivery) + num(a.c_return))
  );
  const totalWorkload = daily.reduce((sum, row) => sum + row.totals.workload, 0);
  const latestDate = daily.map((row) => row.workDate).sort().at(-1) ?? null;
  const latestActiveIds = latestDate ? daily.filter((row) => row.workDate === latestDate).reduce((sum, row) => sum + row.activeIds, 0) : 0;
  const sourceDays = new Set(daily.map((row) => row.workDate)).size;
  const pincodeDelivered = pincodes.reduce((sum, row) => sum + num(row.delivered), 0);
  const pincodeSmall = pincodes.reduce((sum, row) => sum + num(row.small), 0);
  const pincodeVolumetric = pincodes.reduce((sum, row) => sum + num(row.volumetric), 0);
  const pincodeUnclassified = pincodes.reduce((sum, row) => sum + num(row.unclassified), 0);
  const base = `from=${from}&to=${to}${searchParams?.stations ? `&stations=${encodeURIComponent(searchParams.stations)}` : ""}`;
  const sortHref = (label: string, key: string) => <Link href={`/ops-pulse/performance/shipments?${base}&sort=${key}&dir=${sort === key && dir === "desc" ? "asc" : "desc"}`}>{label}{sort === key ? dir === "desc" ? " ↓" : " ↑" : " ↕"}</Link>;
  const scopeStations = locations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code, cluster: location.cluster || "", region: location.region || "" }));
  const error = locationsResult.error || breakdownResult.error?.message || pincodeResult.error?.message;

  return <AppShell active="Capacity" pageCode="cps_shipments"><div className="ops-command-center shipment-workspace">
    <PageHead eyebrow="Capacity" title="Delivery Data" subtitle="Capacity workload = Amazon delivery + SMD + SWA delivery + C-return." />
    <div className="capacity-tabs-toolbar"><CapacityWorkspaceTabs active="delivery" /><CapacityScopeFilter selectedCodes={codes} stations={scopeStations}/></div>
    <section className="ops-control-strip"><div className="ops-context-summary"><span>{selectedDay ? "Associate detail" : selectedStation ? "Daily detail" : "Station overview"}</span><strong>{selectedDay || selectedStation || `${stationRows.length} stations with data`}</strong><small>{from} to {to}</small></div><form className="ops-date-controls"><input name="stations" type="hidden" value={searchParams?.stations ?? ""}/>{selectedStation ? <input name="station" type="hidden" value={selectedStation}/> : null}{selectedDay ? <input name="day" type="hidden" value={selectedDay}/> : null}<label>From<input name="from" type="date" defaultValue={from}/></label><label>To<input name="to" type="date" defaultValue={to}/></label><button>Apply range</button></form></section>
    <nav className="shipment-breadcrumbs"><Link href={`/ops-pulse/performance/shipments?${base}`}>All stations</Link>{selectedStation ? <><span>›</span><Link href={`/ops-pulse/performance/shipments?${base}&station=${selectedStation}`}>{selectedStation}</Link></> : null}{selectedDay ? <><span>›</span><strong>{selectedDay}</strong></> : null}</nav>
    {error ? <section className="panel message-panel error"><div className="panel-body">{error}</div></section> : null}
    {!selectedStation ? <section className="performance-summary-grid shipment-summary-grid"><article><span>Capacity workload</span><strong>{fmt(totalWorkload)}</strong><small>Amazon + SMD + SWA + C-return</small></article><article><span>Latest road IDs</span><strong>{fmt(latestActiveIds)}</strong><small>{latestDate || "No source date"}</small></article><article><span>Source days</span><strong>{sourceDays}</strong><small>Distinct operating dates</small></article><article><span>Stations covered</span><strong>{stationRows.length}</strong><small>{codes.length} eligible stations</small></article></section> : <section className="performance-summary-grid shipment-summary-grid shipment-breakup-summary"><article><span>Capacity workload</span><strong>{fmt(selectedTotals.workload)}</strong><small>Amazon + SMD + SWA + C-return</small></article><article><span>Amazon delivery</span><strong>{fmt(selectedTotals.amazon)}</strong><small>Base Amazon deliveries</small></article><article><span>SMD delivery</span><strong>{fmt(selectedTotals.smd + selectedTotals.smd2)}</strong><small>Included in workload</small></article><article><span>SWA delivery</span><strong>{fmt(selectedTotals.swa)}</strong><small>Included in workload</small></article><article><span>C-return</span><strong>{fmt(selectedTotals.returned)}</strong><small>Included in workload</small></article><article><span>MFN activity</span><strong>{fmt(selectedTotals.mfn + selectedTotals.mfnReturn)}</strong><small>Excluded from SPR</small></article></section>}
    {!selectedStation ? <section className="panel"><div className="panel-head"><div><h2>Station capacity workload</h2><p className="subtle">Open a station for the shipment-type breakup.</p></div></div><div className="table-wrap"><table className="shipment-table"><thead><tr><th>{sortHref("Station", "code")}</th><th>{sortHref("Capacity workload", "workload")}</th><th>{sortHref("Peak road IDs", "activeIds")}</th><th>{sortHref("Source days", "days")}</th><th>{sortHref("Average/day", "average")}</th><th>{sortHref("Average SPR", "spr")}</th></tr></thead><tbody>{stationRows.map((row) => <tr key={row.code}><td><Link href={`/ops-pulse/performance/shipments?${base}&station=${row.code}`}><strong>{row.code}</strong><small>{row.name}</small></Link></td><td><strong>{fmt(row.workload)}</strong></td><td>{fmt(row.activeIds)}</td><td>{row.days}</td><td>{fmt(row.average)}</td><td><strong>{fmt(row.spr, 1)}</strong></td></tr>)}{!stationRows.length ? <tr><td className="empty-cell" colSpan={6}>No delivery data is available in this range.</td></tr> : null}</tbody></table></div></section> : null}
    {selectedStation && !selectedDay ? <section className="panel"><div className="panel-head"><div><h2>{selectedStation} daily breakup</h2><p className="subtle">Amazon Daily Shipment Count only. MFN is shown for reference and excluded from capacity SPR.</p></div></div><div className="table-wrap"><table className="shipment-table shipment-breakup-table"><thead><tr><th>Date</th><th>Road IDs</th><th>Capacity workload</th><th>Amazon delivery</th><th>SMD delivery</th><th>SWA</th><th>C-return</th><th>MFN forward</th><th>MFN return</th><th>SPR</th></tr></thead><tbody>{stationDaily.map((row) => {
      const workload = row.totals.workload;
      return <tr key={row.workDate}><td><Link href={`/ops-pulse/performance/shipments?${base}&station=${selectedStation}&day=${row.workDate}`}><strong>{row.workDate.split("-").reverse().join("/")}</strong><small>View associates</small></Link></td><td>{fmt(row.activeIds)}</td><td><strong>{fmt(workload)}</strong></td><td>{fmt(row.totals.amazon)}</td><td>{fmt(row.totals.smd + row.totals.smd2)}</td><td>{fmt(row.totals.swa)}</td><td>{fmt(row.totals.returned)}</td><td>{fmt(row.totals.mfn)}</td><td>{fmt(row.totals.mfnReturn)}</td><td><strong>{row.activeIds ? fmt(workload / row.activeIds, 1) : "—"}</strong></td></tr>;
    })}{!stationDaily.length ? <tr><td className="empty-cell" colSpan={10}>No delivery data is available for this station.</td></tr> : null}</tbody></table></div></section> : null}
    {selectedStation && selectedDay ? <section className="panel"><div className="panel-head"><div><h2>Associate workload breakup</h2><p className="subtle">{selectedStation} · {selectedDay}</p></div><span className="status-pill neutral">{dayAssociates.length} road-active IDs</span></div><div className="table-wrap"><table className="shipment-table shipment-breakup-table"><thead><tr><th>Associate</th><th>Capacity workload</th><th>Amazon delivery</th><th>SMD delivery</th><th>SWA</th><th>C-return</th><th>MFN forward</th><th>MFN return</th><th>Position</th></tr></thead><tbody>{dayAssociates.map((row) => {
      const workload = num(row.base_amazon_delivery) + num(row.smd_delivery) + num(row.smd2_delivery) + num(row.swa_delivery) + num(row.c_return);
      return <tr key={row.provider_employee_id}><td><Link href={`/ops-pulse/capacity/associates/${encodeURIComponent(row.provider_employee_id)}?station=${selectedStation}&from=${selectedDay}&to=${selectedDay}&detail=selected&name=${encodeURIComponent(row.provider_employee_name || "")}`}><strong>{row.provider_employee_name || row.provider_employee_id}</strong><small>{row.provider_employee_name ? row.provider_employee_id : "Associate ID"}</small></Link></td><td><strong>{fmt(workload)}</strong></td><td>{fmt(num(row.base_amazon_delivery))}</td><td>{fmt(num(row.smd_delivery) + num(row.smd2_delivery))}</td><td>{fmt(num(row.swa_delivery))}</td><td>{fmt(num(row.c_return))}</td><td>{fmt(num(row.mfn))}</td><td>{fmt(num(row.mfn_return))}</td><td><span className={`capacity-decision ${workload > 70 ? "risk" : workload < 60 ? "unconfigured" : "balanced"}`}>{workload > 70 ? "Above safe" : workload < 60 ? "Below target" : "Target range"}</span></td></tr>;
    })}{!dayAssociates.length ? <tr><td className="empty-cell" colSpan={9}>No associate delivery data is available for this date.</td></tr> : null}</tbody></table></div></section> : null}
    {selectedStation ? <section className="panel capacity-associate-delivery-detail">
      <div className="panel-head"><div><h2>Pincode & package mix</h2><p className="subtle">Delivered Detail drilldown for {selectedStation}; official capacity counts above remain unchanged.</p></div><span className="status-pill neutral">{selectedDay ? selectedDay.split("-").reverse().join("/") : `${from.split("-").reverse().join("/")}–${to.split("-").reverse().join("/")}`}</span></div>
      <div className="performance-summary-grid shipment-breakup-summary">
        <article><span>Detailed shipments</span><strong>{fmt(pincodeDelivered)}</strong><small>Tracking-level delivered rows</small></article>
        <article><span>Pincodes served</span><strong>{fmt(pincodes.length)}</strong><small>{selectedDay ? "Selected day" : "Selected range"}</small></article>
        <article><span>Small mix</span><strong>{pincodeDelivered ? `${fmt(pincodeSmall / pincodeDelivered * 100, 1)}%` : "—"}</strong><small>{fmt(pincodeSmall)} shipments</small></article>
        <article><span>Volumetric mix</span><strong>{pincodeDelivered ? `${fmt(pincodeVolumetric / pincodeDelivered * 100, 1)}%` : "—"}</strong><small>{fmt(pincodeVolumetric)} shipments</small></article>
      </div>
      <div className="table-wrap"><table className="shipment-table shipment-breakup-table"><thead><tr><th>Pincode</th><th>Detailed shipments</th><th>Share</th><th>Serving IDs</th><th>Active days</th><th>Small</th><th>Small mix</th><th>Volumetric</th><th>Volumetric mix</th><th>Unclassified</th></tr></thead><tbody>{pincodes.map((row) => {
        const delivered = num(row.delivered);
        const small = num(row.small);
        const volumetric = num(row.volumetric);
        const evidenceBase = `/ops-pulse/capacity/shipments?station=${selectedStation}&pincode=${encodeURIComponent(row.postal_code)}&from=${pincodeFrom}&to=${pincodeTo}`;
        return <tr key={row.postal_code}><td><strong>{row.postal_code}</strong></td><td><Link href={evidenceBase}>{fmt(delivered)}</Link></td><td>{pincodeDelivered ? `${fmt(delivered / pincodeDelivered * 100, 1)}%` : "—"}</td><td>{fmt(num(row.active_ids))}</td><td>{fmt(num(row.active_days))}</td><td><Link href={`${evidenceBase}&size=small`}>{fmt(small)}</Link></td><td>{delivered ? `${fmt(small / delivered * 100, 1)}%` : "—"}</td><td><Link href={`${evidenceBase}&size=volumetric`}>{fmt(volumetric)}</Link></td><td>{delivered ? `${fmt(volumetric / delivered * 100, 1)}%` : "—"}</td><td>{fmt(num(row.unclassified))}</td></tr>;
      })}{!pincodes.length ? <tr><td className="empty-cell" colSpan={10}>No pincode-level Delivered Detail is available for this station and period.</td></tr> : null}</tbody></table></div>
      {pincodeUnclassified ? <div className="capacity-source-gap"><strong>{fmt(pincodeUnclassified)} shipments need package classification</strong><span>One or more weight/dimension fields are missing in Delivered Detail.</span></div> : null}
    </section> : null}
  </div></AppShell>;
}
