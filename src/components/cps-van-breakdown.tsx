import { ChevronDown } from "lucide-react";
import { calendarDays, groupVanCosts, type CostItem } from "@/lib/ops-pulse/cps-cost-details";
import { ratio, type CpsSnapshot } from "@/lib/ops-pulse/cps";

const money = (value: number | null) => value == null ? "—" : `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function SourceItem({ item, snapshot, deliveries }: { item: CostItem; snapshot: CpsSnapshot; deliveries: number }) {
  const vehicles = item.source === "Fleet Vehicle Master" ? (snapshot.vehicles ?? []).filter(v =>
    item.label === `Vehicle rent · ${v.vehicle_no}` && item.lines.some(l => l.station_code === v.station_code)) : [];
  const days = [...new Set(item.lines.map(l => l.work_date))].sort();
  return <details className="cps-cost-item">
    <summary><span><ChevronDown size={14}/><strong>{item.label}</strong><small>{item.source} · {days.length} cost days</small></span><strong>{money(item.amount)}</strong><span>{money(ratio(item.amount, deliveries))}</span></summary>
    {vehicles.length > 0 && <div className="cps-rent-details">
      {vehicles.map((v,i) => <article key={`${v.vehicle_id}|${v.station_code}|${v.from_date}|${i}`}>
        <header><strong>{v.vehicle_no} · {v.station_code}</strong><span>{v.model}</span></header>
        <dl>
          <div><dt>{v.daily_rent != null ? "Configured daily rent" : "Actual monthly rent"}</dt><dd>{money(v.daily_rent ?? v.monthly_rent)}</dd></div>
          <div><dt>Deployed days</dt><dd>{v.days}</dd></div>
          {v.daily_rent == null && <div><dt>Calendar days in month</dt><dd>{calendarDays(v.from_date)}</dd></div>}
          <div><dt>Accrued Fleet cost</dt><dd>{money(v.amount)}</dd></div>
        </dl>
        <p>{v.from_date} – {v.through_date}. {v.daily_rent != null ? "Daily rate × eligible deployed days." : "Monthly rate ÷ calendar days × eligible deployed days."} Fleet deployment and rent-status rules apply.</p>
      </article>)}
    </div>}
    <div className="cps-table-wrap cps-source-days"><table><caption>Daily charges · {item.source}</caption><thead><tr><th>Date</th><th>Station</th><th>Amount</th></tr></thead><tbody>
      {[...item.lines].sort((a,b) => a.work_date.localeCompare(b.work_date) || a.station_code.localeCompare(b.station_code)).map((line,i) => <tr key={`${line.work_date}|${line.station_code}|${i}`}><td>{line.work_date}</td><td>{line.station_code}</td><td>{money(line.amount)}</td></tr>)}
    </tbody><tfoot><tr><th colSpan={2}>Item total</th><th>{money(item.amount)}</th></tr></tfoot></table></div>
  </details>;
}
export function CpsVanBreakdown({ snapshot, deliveries, amount }: { snapshot: CpsSnapshot; deliveries: number; amount: number }) {
  const groups = groupVanCosts(snapshot.breakup);
  return <div className="cps-grouped-costs">
    <div className="cps-cost-columns"><span>Cost group · expand for details</span><span>Period cost</span><span>CPS</span></div>
    {groups.map(group => <details className="cps-cost-group" key={group.key}>
      <summary><span><ChevronDown size={16}/><strong>{group.label}</strong><small>{group.items.length} {group.key === "rental" ? "vehicles" : "cost items"} · {new Set(group.items.map(i=>i.source)).size} {new Set(group.items.map(i=>i.source)).size === 1 ? "source" : "sources"}</small></span><strong>{money(group.amount)}</strong><span>{money(ratio(group.amount,deliveries))}</span></summary>
      <div className="cps-cost-group-body">{group.items.map(item => <SourceItem key={item.key} item={item} snapshot={snapshot} deliveries={deliveries}/>)}</div>
    </details>)}
    <div className="cps-grouped-total"><strong>Van total</strong><strong>{money(amount)}</strong><strong>{money(ratio(amount,deliveries))}</strong></div>
    <p className="cps-footnote">Amounts cover the selected dates. CPS uses the same delivered-shipment total throughout. Expand a group, then a cost item, for rates and daily charges.</p>
  </div>;
}
