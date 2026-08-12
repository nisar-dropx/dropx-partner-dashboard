import { AppShell } from "@/components/app-shell";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCapacityRules } from "@/lib/ops-pulse/capacity";
import {
  loadCapacityAssociateDeliveredDaily,
  loadCapacityAssociatePincodes,
  loadCapacityDeliveryBreakdown,
  type CapacityDeliveryBreakdown
} from "@/lib/ops-pulse/capacity-shipments";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { associateMatches } from "@/lib/ops-pulse/associate-identity";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
type SearchParams = { station?: string; from?: string; to?: string; name?: string; detail?: string };
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function yesterday() { const date = new Date(`${today()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
function valid(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function fmt(value: number, digits = 0) { return value.toLocaleString("en-IN", { maximumFractionDigits: digits }); }
function num(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
type DeliveryTotals = {
  amazon: number;
  smd: number;
  smd2: number;
  swa: number;
  returned: number;
  mfn: number;
  mfnReturn: number;
  assigned: number;
  workload: number;
};
function emptyTotals(): DeliveryTotals {
  return { amazon: 0, smd: 0, smd2: 0, swa: 0, returned: 0, mfn: 0, mfnReturn: 0, assigned: 0, workload: 0 };
}
function addBreakdown(total: DeliveryTotals, row: CapacityDeliveryBreakdown) {
  total.amazon += num(row.base_amazon_delivery);
  total.smd += num(row.smd_delivery);
  total.smd2 += num(row.smd2_delivery);
  total.swa += num(row.swa_delivery);
  total.returned += num(row.c_return);
  total.mfn += num(row.mfn);
  total.mfnReturn += num(row.mfn_return);
  total.assigned += num(row.assigned_count);
  total.workload += num(row.base_amazon_delivery) + num(row.smd_delivery) + num(row.smd2_delivery) + num(row.swa_delivery) + num(row.c_return);
  return total;
}

export default async function AssociateCapacityPage({ params, searchParams }: { params: { id: string }; searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cps_associates", "access");
  const companyId = requireCompanyId(authorization);
  const id = decodeURIComponent(params.id);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const allowedCodes = locationResult.locations.map((location) => location.station_code);
  const station = String(searchParams?.station ?? "").toUpperCase();
  if (!allowedCodes.includes(station)) notFound();
  const end = valid(searchParams?.to) ? String(searchParams?.to) : yesterday();
  const start = valid(searchParams?.from) ? String(searchParams?.from) : end;
  const requestedName = String(searchParams?.name ?? "").trim();
  const monthStart = `${end.slice(0, 8)}01`;
  const detailMode = searchParams?.detail === "mtd" ? "mtd" : searchParams?.detail === "selected" ? "selected" : start === end ? "selected" : "mtd";
  const pincodeFrom = detailMode === "mtd" ? monthStart : start;
  const [shipmentResult, ruleResult, selectedDetailResult, mtdDetailResult, pincodeResult] = await Promise.all([
    loadCapacityDeliveryBreakdown(companyId, [station], start, end),
    loadCapacityRules(companyId),
    loadCapacityAssociateDeliveredDaily(companyId, station, id, requestedName, start, end),
    loadCapacityAssociateDeliveredDaily(companyId, station, id, requestedName, monthStart, end),
    loadCapacityAssociatePincodes(companyId, station, id, requestedName, pincodeFrom, end)
  ]);
  const rows = (shipmentResult.data ?? []).filter((row) => associateMatches(id, requestedName, row.provider_employee_id, row.provider_employee_name));
  const totalsByIdentityDay = new Map<string, DeliveryTotals>();
  rows.forEach((row) => {
    const key = `${row.work_date}|${row.provider_employee_id}`;
    totalsByIdentityDay.set(key, addBreakdown(totalsByIdentityDay.get(key) ?? emptyTotals(), row));
  });
  const dailyMap = new Map<string, DeliveryTotals>();
  totalsByIdentityDay.forEach((value, key) => {
    const date = key.slice(0, 10);
    const current = dailyMap.get(date);
    if (!current || value.workload > current.workload) dailyMap.set(date, value);
  });
  const daily = [...dailyMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, breakup]) => ({ date, ...breakup }));
  const officialTotals = daily.reduce((total, row) => ({
    amazon: total.amazon + row.amazon,
    smd: total.smd + row.smd,
    smd2: total.smd2 + row.smd2,
    swa: total.swa + row.swa,
    returned: total.returned + row.returned,
    mfn: total.mfn + row.mfn,
    mfnReturn: total.mfnReturn + row.mfnReturn,
    assigned: total.assigned + row.assigned,
    workload: total.workload + row.workload
  }), emptyTotals());
  const total = officialTotals.workload;
  const average = daily.length ? total / daily.length : 0;
  const peak = Math.max(0, ...daily.map((row) => row.workload));
  const safe = ruleResult.rows.find((rule) => rule.stationCode === station)?.maxSafeSpr ?? 70;
  const name = requestedName || rows.find((row) => row.provider_employee_name)?.provider_employee_name || id;
  const highDays = daily.filter((row) => row.workload > safe).length;
  const selectedDetail = selectedDetailResult.data ?? [];
  const mtdDetail = mtdDetailResult.data ?? [];
  const pincodes = pincodeResult.data ?? [];
  const selectedDetailDelivered = selectedDetail.reduce((sum, row) => sum + Number(row.delivered), 0);
  const periodDetail = detailMode === "mtd" ? mtdDetail : selectedDetail;
  const periodDelivered = periodDetail.reduce((sum, row) => sum + Number(row.delivered), 0);
  const periodVolumetric = periodDetail.reduce((sum, row) => sum + Number(row.volumetric), 0);
  const periodSmall = periodDetail.reduce((sum, row) => sum + Number(row.small), 0);
  const periodUnclassified = periodDetail.reduce((sum, row) => sum + Number(row.unclassified), 0);
  const latestDetail = mtdDetail.at(-1);
  const detailError = selectedDetailResult.error?.message || mtdDetailResult.error?.message || pincodeResult.error?.message;

  return <AppShell active="Capacity" pageCode="cps_associates"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Associate Allocation" title={name} subtitle={`${id} · ${station}`} />
    <CapacityWorkspaceTabs active="associates" />
    {locationResult.error || shipmentResult.error || ruleResult.error || detailError ? <div className="message-panel error">{locationResult.error || shipmentResult.error?.message || ruleResult.error || detailError}</div> : null}
    <div className="capacity-station-toolbar"><a className="button secondary compact" href={`/ops-pulse/capacity/associates?station=${station}&from=${start}&to=${end}`}>← Associate SPR</a><form method="get"><input type="hidden" name="station" value={station}/>{requestedName ? <input type="hidden" name="name" value={requestedName}/> : null}<label>From<input type="date" name="from" defaultValue={start}/></label><label>To<input type="date" name="to" defaultValue={end}/></label><button className="button compact">Apply</button></form></div>
    <section className="performance-summary-grid"><article><span>Days worked</span><strong>{daily.length}</strong><small>Shipment-active days</small></article><article><span>Total workload</span><strong>{fmt(total)}</strong><small>Amazon + SMD + SWA + C-return</small></article><article><span>Average allocation</span><strong>{fmt(average, 1)}</strong><small>Workload per active day</small></article><article><span>High-load days</span><strong>{highDays}</strong><small>Above safe SPR {fmt(safe)}</small></article></section>
    <section className="performance-summary-grid shipment-breakup-summary"><article><span>Amazon delivery</span><strong>{fmt(officialTotals.amazon)}</strong><small>Base delivery</small></article><article><span>SMD delivery</span><strong>{fmt(officialTotals.smd + officialTotals.smd2)}</strong><small>SMD + SMD2</small></article><article><span>SWA delivery</span><strong>{fmt(officialTotals.swa)}</strong><small>Included in workload</small></article><article><span>C-return</span><strong>{fmt(officialTotals.returned)}</strong><small>Included in workload</small></article><article><span>MFN forward</span><strong>{fmt(officialTotals.mfn)}</strong><small>Excluded from SPR</small></article><article><span>MFN return</span><strong>{fmt(officialTotals.mfnReturn)}</strong><small>Excluded from SPR</small></article></section>
    <section className="panel"><div className="panel-head"><div><h2>Daily allocation trend</h2><p className="subtle">Official workload and breakup from Amazon Daily Shipment Count.</p></div></div><div className="capacity-associate-trend">{daily.map((row) => <div key={row.date}><span>{row.date.slice(5)}</span><i style={{ width: `${peak ? Math.max(3, row.workload / peak * 100) : 0}%` }} className={row.workload > safe ? "risk" : ""}/><strong>{fmt(row.workload)}</strong></div>)}</div><div className="table-wrap"><table className="capacity-daily-table"><thead><tr><th>Date</th><th>Workload</th><th>Amazon</th><th>SMD</th><th>SWA</th><th>C-return</th><th>MFN</th><th>MFN return</th><th>Safe SPR</th><th>Status</th></tr></thead><tbody>{daily.map((row) => <tr key={row.date}><td>{row.date.split("-").reverse().join("/")}</td><td><strong>{fmt(row.workload)}</strong></td><td>{fmt(row.amazon)}</td><td>{fmt(row.smd + row.smd2)}</td><td>{fmt(row.swa)}</td><td>{fmt(row.returned)}</td><td>{fmt(row.mfn)}</td><td>{fmt(row.mfnReturn)}</td><td>{fmt(safe)}</td><td><span className={`capacity-decision ${row.workload > safe ? "risk" : "balanced"}`}>{row.workload > safe ? `High +${fmt(row.workload - safe)}` : "Within safe"}</span></td></tr>)}</tbody></table></div></section>
    <section className="panel capacity-associate-delivery-detail">
      <div className="panel-head"><div><h2>Pincode & package mix</h2><p className="subtle">Delivered Detail is used only for pincode and package-size analysis.</p></div><div className="listing-head-actions"><a className={`button compact ${detailMode === "selected" ? "" : "secondary"}`} href={`?station=${station}&from=${start}&to=${end}&detail=selected&name=${encodeURIComponent(requestedName)}`}>Selected period</a><a className={`button compact ${detailMode === "mtd" ? "" : "secondary"}`} href={`?station=${station}&from=${start}&to=${end}&detail=mtd&name=${encodeURIComponent(requestedName)}`}>MTD</a><span className="status-pill neutral">{pincodeFrom.split("-").reverse().join("/")}–{end.split("-").reverse().join("/")}</span></div></div>
      <div className="capacity-source-gap"><strong>Official counts remain above</strong><span>Capacity workload and its Amazon/SMD/SWA/C-return/MFN breakup are never replaced by Delivered Detail.</span></div>
      <div className="performance-summary-grid">
        <article><span>Selected detail rows</span><strong>{fmt(selectedDetailDelivered)}</strong><small>{start === end ? start.split("-").reverse().join("/") : `${start.split("-").reverse().join("/")}–${end.split("-").reverse().join("/")}`}</small></article>
        <article><span>Latest detail rows</span><strong>{latestDetail ? fmt(Number(latestDetail.delivered)) : "—"}</strong><small>{latestDetail ? latestDetail.work_date.split("-").reverse().join("/") : "No delivered detail"}</small></article>
        <article><span>{detailMode === "mtd" ? "MTD" : "Period"} detail rows</span><strong>{fmt(periodDelivered)}</strong><small>{pincodes.length} pincodes served</small></article>
        <article><span>Small mix</span><strong>{periodDelivered ? `${fmt(periodSmall / periodDelivered * 100, 1)}%` : "—"}</strong><small>{fmt(periodSmall)} shipments</small></article>
        <article><span>Volumetric mix</span><strong>{periodDelivered ? `${fmt(periodVolumetric / periodDelivered * 100, 1)}%` : "—"}</strong><small>{fmt(periodVolumetric)} shipments</small></article>
      </div>
      <div className="table-wrap"><table className="capacity-daily-table"><thead><tr><th>Pincode</th><th>Detail rows</th><th>MTD share</th><th>Active days</th><th>Small</th><th>Small mix</th><th>Volumetric</th><th>Volumetric mix</th></tr></thead><tbody>
        {pincodes.map((row) => {
          const delivered = Number(row.delivered);
          const small = Number(row.small);
          const volumetric = Number(row.volumetric);
          const base = `/ops-pulse/capacity/shipments?station=${station}&associate=${encodeURIComponent(id)}&pincode=${row.postal_code}&from=${pincodeFrom}&to=${end}`;
          return <tr key={row.postal_code}><td><strong>{row.postal_code}</strong></td><td><a href={base}>{fmt(delivered)}</a></td><td>{periodDelivered ? `${fmt(delivered / periodDelivered * 100, 1)}%` : "—"}</td><td>{fmt(Number(row.active_days))}</td><td><a href={`${base}&size=small`}>{fmt(small)}</a></td><td>{delivered ? `${fmt(small / delivered * 100, 1)}%` : "—"}</td><td><a href={`${base}&size=volumetric`}>{fmt(volumetric)}</a></td><td>{delivered ? `${fmt(volumetric / delivered * 100, 1)}%` : "—"}</td></tr>;
        })}
        {!pincodes.length ? <tr><td className="empty-cell" colSpan={8}>No tracking-level delivered detail is available for this associate and period.</td></tr> : null}
      </tbody></table></div>
      {periodUnclassified ? <div className="capacity-source-gap"><strong>{fmt(periodUnclassified)} shipments are unclassified</strong><span>Weight or dimensions are missing in the delivered-detail source.</span></div> : null}
    </section>
  </div></AppShell>;
}
