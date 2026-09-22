import { AppShell } from "@/components/app-shell";
import { CapacityAssociateViewTabs } from "@/components/capacity-associate-view-tabs";
import { CapacityScopeFilter } from "@/components/capacity-scope-filter";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import { loadCapacityRules } from "@/lib/ops-pulse/capacity";
import { loadShipmentCountAssociateDays } from "@/lib/ops-pulse/capacity-shipments";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { associateIdentityKey } from "@/lib/ops-pulse/associate-identity";

export const dynamic = "force-dynamic";
type SearchParams = { from?: string; to?: string; preset?: string; stations?: string; cluster?: string; band?: string };
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const fmt = (value: number, digits = 0) => value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); }
function shift(value: string, days: number) { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function valid(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function scoped(value: string | undefined, allowed: string[]) { if (!value) return allowed; if (value === "_none") return []; const wanted = value.split(",").map((v) => v.trim().toUpperCase()); return allowed.filter((code) => wanted.includes(code)); }

export default async function LowProductivityAssociatesPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_associates", "access");
  const companyId = requireCompanyId(authorization);
  const workspaceTabs = allowedCapacityWorkspaceTabs(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = locationResult.locations.filter(isAmazonEdspXptLocation);
  const clusters = [...new Set(locations.map((location) => location.cluster || "").filter(Boolean))].sort();
  const cluster = clusters.includes(String(searchParams?.cluster ?? "")) ? String(searchParams?.cluster) : "";
  const clusterLocations = cluster ? locations.filter((location) => location.cluster === cluster) : locations;
  const selectedCodes = scoped(searchParams?.stations, clusterLocations.map((location) => location.station_code));
  const preset = ["yesterday", "wtd", "mtd", "ytd", "custom"].includes(String(searchParams?.preset)) ? String(searchParams?.preset) : "yesterday";
  const end = valid(searchParams?.to) ? String(searchParams?.to) : shift(today(), -1);
  const start = preset === "custom" && valid(searchParams?.from) ? String(searchParams?.from) : preset === "yesterday" ? end : preset === "mtd" ? `${end.slice(0, 8)}01` : preset === "ytd" ? `${end.slice(0, 4)}-01-01` : shift(end, -((new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7));
  const [rules, shipmentResult] = await Promise.all([loadCapacityRules(companyId), loadShipmentCountAssociateDays(companyId, selectedCodes, start, end)]);
  const ruleByStation = new Map(rules.rows.map((row) => [row.stationCode, row]));
  const daily = new Map<string, { id: string; name: string; station: string; date: string; delivery: number; returns: number; variable: number; salary: number; fuel: number; paid: number; payType: string; mapped: string }>();
  for (const row of shipmentResult.data ?? []) {
    const id = String(row.provider_employee_id ?? "").trim(); if (!id) continue;
    const key = `${row.station_code}|${row.work_date}|${associateIdentityKey(row.station_code, id, row.provider_employee_name)}`;
    const candidate = { id, name: row.provider_employee_name || id, station: row.station_code, date: row.work_date, delivery: num(row.amazon_delivery), returns: num(row.c_return), variable: num(row.variable_pay), salary: num(row.mg_pay), fuel: num(row.fuel_pay), paid: num(row.da_total_pay), payType: row.pay_type || "Not configured", mapped: row.mapping_status || "Unmapped" };
    const existing = daily.get(key);
    if (!existing || candidate.delivery + candidate.returns > existing.delivery + existing.returns) daily.set(key, candidate);
  }
  const people = new Map<string, { id: string; name: string; station: string; days: number; delivery: number; returns: number; paid: number; variable: number; salary: number; fuel: number; missingPay: boolean }>();
  daily.forEach((row) => { const key = associateIdentityKey(row.station, row.id, row.name); const current = people.get(key) ?? { id: row.id, name: row.name, station: row.station, days: 0, delivery: 0, returns: 0, paid: 0, variable: 0, salary: 0, fuel: 0, missingPay: false }; current.days++; current.delivery += row.delivery; current.returns += row.returns; current.paid += row.paid; current.variable += row.variable; current.salary += row.salary; current.fuel += row.fuel; current.missingPay ||= row.mapped !== "Mapped"; people.set(key, current); });
  const threshold = Math.min(...rules.rows.map((rule) => rule.targetSpr).filter((value): value is number => value != null), 45);
  const rows = [...people.values()].map((row) => { const total = row.delivery + row.returns; const productivity = row.days ? total / row.days : 0; return { ...row, total, productivity, cps: total ? row.paid / total : null, target: ruleByStation.get(row.station)?.targetSpr ?? threshold }; }).filter((row) => row.productivity < row.target).sort((a, b) => a.productivity - b.productivity || b.total - a.total);
  const totalCount = rows.reduce((sum, row) => sum + row.total, 0); const totalPaid = rows.reduce((sum, row) => sum + row.paid, 0);
  const scopeStations = clusterLocations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code, cluster: location.cluster || "", region: location.region || "" }));
  const exportParams = new URLSearchParams({ from: start, to: end });
  if (cluster) exportParams.set("cluster", cluster); if (searchParams?.stations) exportParams.set("stations", searchParams.stations);
  return <AppShell active="Capacity" pageCode="capacity_associates"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Associate Productivity" title="Low productivity associates" subtitle="Productivity uses Delivery + C-return; MFN is excluded. CPS uses the actual calculated associate payout." />
    <div className="capacity-tabs-toolbar"><CapacityWorkspaceTabs active="associates" allowed={workspaceTabs}/><CapacityScopeFilter selectedCodes={selectedCodes} stations={scopeStations}/></div>
    <CapacityAssociateViewTabs active="low-productivity"/>
    {locationResult.error || rules.error || shipmentResult.error ? <div className="message-panel error">{locationResult.error || rules.error || shipmentResult.error?.message}</div> : null}
    <form className="capacity-period-filter capacity-associate-filter" method="get"><input name="stations" type="hidden" value={searchParams?.stations ?? ""}/><label>Cluster<select name="cluster" defaultValue={cluster}><option value="">All clusters</option>{clusters.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>Period<select name="preset" defaultValue={preset}><option value="yesterday">Yesterday</option><option value="wtd">Week to date</option><option value="mtd">Month to date</option><option value="ytd">Year to date</option><option value="custom">Custom</option></select></label><label>From<input name="from" type="date" defaultValue={start}/></label><label>To<input name="to" type="date" defaultValue={end}/></label><button className="button compact">Apply</button></form>
    <section className="performance-summary-grid"><article><span>Below target</span><strong>{rows.length}</strong><small>Accessible associates in the selected period</small></article><article><span>Average productivity</span><strong>{fmt(rows.length ? rows.reduce((sum, row) => sum + row.productivity, 0) / rows.length : 0, 1)}</strong><small>Delivery + C-return per day worked</small></article><article><span>Total count</span><strong>{fmt(totalCount)}</strong><small>Delivery + C-return only</small></article><article><span>Range CPS</span><strong>{totalCount ? `₹${fmt(totalPaid / totalCount, 2)}` : "—"}</strong><small>Total paid amount ÷ total count</small></article></section>
    <section className="panel"><div className="panel-head"><div><h2>Low productivity associates</h2><p className="subtle">CPS aggregates each day’s variable pay, salary/minimum guarantee and fuel payment, then divides the whole period’s paid amount by Delivery + C-return.</p></div><a className="button secondary compact" href={`/api/ops-pulse/capacity/low-productivity/export?${exportParams.toString()}`}>Download Excel</a></div><div className="table-wrap"><table className="capacity-daily-table"><thead><tr><th>Associate</th><th>Station</th><th>Days worked</th><th>Delivery</th><th>C-return</th><th>Total count</th><th>Productivity</th><th>Cost / shipment</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={associateIdentityKey(row.station, row.id, row.name)}><td><a className="capacity-station-link" href={`/ops-pulse/capacity/associates/${encodeURIComponent(row.id)}?station=${row.station}&from=${start}&to=${end}&name=${encodeURIComponent(row.name)}&mode=cps`}><strong>{row.name}</strong><small>{row.id}</small></a></td><td>{row.station}</td><td>{row.days}</td><td>{fmt(row.delivery)}</td><td>{fmt(row.returns)}</td><td><strong>{fmt(row.total)}</strong></td><td><strong className="metric-warn-text">{fmt(row.productivity, 1)}</strong></td><td>{row.cps == null ? "Payment not mapped" : `₹${fmt(row.cps, 2)}`}</td><td><span className="capacity-decision unconfigured">Below target</span></td></tr>)}{!rows.length ? <tr><td className="empty-cell" colSpan={9}>No below-target associates match these filters.</td></tr> : null}</tbody></table></div></section>
  </div></AppShell>;
}
