"use client";
import { useState } from "react";
import { daCohortTotals, type CpsDaDetail } from "@/lib/ops-pulse/cps-details";
import { ratio } from "@/lib/ops-pulse/cps";
const money=(n:number|null)=>n==null?"—":`₹${n.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const count=(n:number)=>n.toLocaleString("en-IN");
const payout=(r:CpsDaDetail)=>r.salary+r.variable+r.fuel;
export function CpsAssociateTable({rows,component,source}:{rows:CpsDaDetail[];source?:string;component?:"salary"|"variable"|"fuel"|"van"}) {
  const componentAmount=(r:CpsDaDetail)=>component?(source?r.periods.filter(p=>p.source===source).reduce((n,p)=>n+p[component],0):r[component]):payout(r);
  const visible=component?rows.filter(r=>componentAmount(r)!==0):rows;
  return <div className="cps-associate-details">
    <p className="cps-footnote">Calculated payout for the selected dates, before payroll settlement. DA CPS = (fixed pay + variable pay + DA fuel) ÷ that associate’s delivered shipments. Vehicle rent stays under Van CPS.</p>
    {!visible.length?<p className="panel-body">No mapped associate costs in this group.</p>:<>
    <div className="cps-da-column-head"><span>Associate · expand for rate card</span><span>Worked days</span><span>Delivered / returns</span><span>{component?`${component==='salary'?'Fixed':component[0].toUpperCase()+component.slice(1)} component`:"Calculated payout"}</span><span>DA CPS</span></div>
    {visible.map(r=><details className="cps-da-person" key={`${r.worker_id}|${r.station_code}|${r.cohort}`}>
      <summary>
        <span><strong>{r.name}</strong><small>{r.dropx_id} · {r.cohort==='variable'?'Variable pay':'Salary / minimum guarantee'}</small></span>
        <span>{r.work_dates.length}<small>{r.work_bases.join(" / ")||"No work evidence"}</small></span>
        <span>{count(r.deliveries)}<small>{count(r.customer_returns+r.seller_returns)} returns · {count(r.seller_pickups)} pickups</small></span>
        <span>{money(componentAmount(r))}{component&&<small>{money(payout(r))} total DA payout</small>}</span>
        <span>{money(ratio(payout(r),r.deliveries))}<small>{!r.deliveries?"No delivered shipments":"per own delivery"}</small></span>
      </summary>
      <div className="cps-da-person-body">
        <p><strong>Provider IDs:</strong> {r.provider_ids.join(", ")||"Direct / People allocation"}</p>
        <div className="cps-da-metrics">
          <span>Fixed / MG<strong>{money(r.salary)}</strong></span><span>Variable<strong>{money(r.variable)}</strong></span>
          <span>DA fuel<strong>{money(r.fuel)}</strong></span><span>DA payout<strong>{money(payout(r))}</strong></span>
          {r.van!==0&&<span>Vehicle component · Van<strong>{money(r.van)}</strong></span>}
        </div>
        <p className="cps-footnote">{r.work_dates.length} distinct worked days from {r.work_bases.join(" and ")||"available evidence"}; {r.cost_dates.length} recorded cost / activity days. Calendar salary can accrue on days with no deliveries. Returns are shown separately and are not added to the CPS denominator.</p>
        <div className="cps-table-wrap"><table><thead><tr><th>Applied dates</th><th>Effective rate card</th><th>Delivered</th><th>Customer returns</th><th>Seller pickup / return</th><th>Fixed / MG</th><th>Variable</th><th>DA fuel</th><th>DA payout</th></tr></thead><tbody>
          {r.periods.map((p,i)=><tr key={i}><td>{p.from} – {p.to}<small>Card effective {p.card_from} · {p.source}</small></td><td className="cps-rate-cell">{p.rates.map((rate,j)=><small key={j}><strong>{rate.label}</strong> {money(rate.rate)} / {rate.basis}</small>)}</td><td>{count(p.deliveries)}</td><td>{count(p.customer_returns)}</td><td>{count(p.seller_pickups)} / {count(p.seller_returns)}</td><td>{money(p.salary)}</td><td>{money(p.variable)}</td><td>{money(p.fuel)}</td><td>{money(p.salary+p.variable+p.fuel)}</td></tr>)}
        </tbody></table></div>
      </div>
    </details>)}
    </>}
  </div>;
}
export function CpsDaCohorts({rows}:{rows:CpsDaDetail[]}) {
  const [selected,setSelected]=useState<"variable"|"guarantee"|null>(null);
  return <section className="cps-cohorts" aria-label="DA pay groups">
    <div className="cps-cohort-cards">{(["variable","guarantee"] as const).map(cohort=>{
      const g=daCohortTotals(rows,cohort);
      return <button type="button" key={cohort} className={selected===cohort?"selected":""} onClick={()=>setSelected(selected===cohort?null:cohort)} aria-expanded={selected===cohort} aria-controls="cps-cohort-details">
        <span>{cohort==='variable'?'Variable pay DAs':'Salary / minimum guarantee DAs'}</span>
        <strong>{money(g.cps)} <small>/ delivery by this group</small></strong>
        <span>{money(g.amount)} ÷ {count(g.deliveries)} deliveries</span>
        <small>{new Set(g.people.map(p=>p.worker_id)).size} associates · {selected===cohort?'Hide associates ↑':'View associates & rate cards →'}</small>
      </button>;
    })}</div>
    <p className="cps-footnote">Each group uses its own deliveries. These two CPS values are not added together. The DA CPS above uses all station deliveries and includes spot DA costs. An associate changing pay type appears under the applicable group for each dated card.</p>
    {selected&&<div id="cps-cohort-details"><CpsAssociateTable rows={rows.filter(r=>r.cohort===selected)}/></div>}
  </section>;
}
