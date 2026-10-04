"use client";
import { useState } from "react";
import { ArrowRight, ChevronDown, CircleAlert, Fuel, Truck, Users, Wallet } from "lucide-react";
import { groupCps, ratio, summarizeCps, type CpsHead, type CpsSnapshot } from "@/lib/ops-pulse/cps";

const money=(n:number|null,digits=0)=>n==null?'—':`₹${Number(n).toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
const count=(n:number)=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:0});
type Head='DA'|'UTR'|'Van'|'Other';
const groupHead=(head:CpsHead):Head=>head==='Rent'||head==='Overhead'?'Other':head;
const categories: {head:Head;label:string;note:string;icon:typeof Users}[]=[
  {head:'DA',label:'DA CPS',note:'Mapped payouts + spot DA',icon:Users},
  {head:'UTR',label:'UTR CPS',note:'Active People CTC + staff costs',icon:Wallet},
  {head:'Van',label:'Van CPS',note:'Vehicle rent, drivers, fuel & ad hoc',icon:Truck},
  {head:'Other',label:'Other CPS',note:'Station rent, utilities & other costs',icon:Fuel},
];
export function CpsCostWorkspace({snapshot,stationNames,stationHref,initialHead='DA',showAttention=false,canResolve=true}:{
  snapshot:CpsSnapshot;stationNames:Record<string,string>;stationHref:Record<string,string>;
  initialHead?:string;showAttention?:boolean;canResolve?:boolean;
}) {
  const [head,setHead]=useState<Head>(categories.some(c=>c.head===initialHead)?initialHead as Head:'DA');
  const [attention,setAttention]=useState(showAttention);
  const [tableSearch,setTableSearch]=useState('');
  const total=summarizeCps(snapshot.daily);
  const costs={DA:total.da,UTR:total.utr,Van:total.van,Other:total.other+total.rent+total.overhead};
  const gaps=snapshot.gaps??[];
  const bySource=new Map<string,{label:string;source:string;head:string;amount:number}>();
  for(const l of snapshot.breakup) {
    if(groupHead(l.head)!==head)continue;
    const key=`${l.head}|${l.sub_head}|${l.source}`;
    const row=bySource.get(key)??{label:l.sub_head,source:l.source,head:l.head,amount:0};row.amount+=Number(l.amount);bySource.set(key,row);
  }
  const stationRows=groupCps(snapshot.daily,r=>r.station_code).filter(r=>`${r.key} ${stationNames[r.key]}`.toLowerCase().includes(tableSearch.toLowerCase())).sort((a,b)=>a.key.localeCompare(b.key));
  const staff=(snapshot.staff??[]).filter(p=>groupHead(p.head)===head);
  const vehicles=snapshot.vehicles??[];
  return <>
    <section className="cps-summary-strip" aria-label="CPS summary">
      <div><span>Delivered shipments</span><strong>{count(total.deliveries)}</strong><small>Across selected stations and dates</small></div>
      <div><span>Total operating cost</span><strong>{money(total.total)}</strong><small>All four cost groups combined</small></div>
      <div className="cps-total"><span>{total.provisional?'Provisional CPS':'Total CPS'}</span><strong>{money(total.cps,2)}</strong><small>Total expenses ÷ delivered shipments</small></div>
    </section>
    {(gaps.length>0||total.missingDays>0) && <section className="cps-alert" aria-live="polite"><CircleAlert size={20}/><div><strong>{gaps.length} source issues need attention</strong><p>{count(total.exposedDeliveries)} deliveries await cost mapping. Missing costs are shown as gaps, never assumed to be zero.</p></div><button type="button" onClick={()=>setAttention(!attention)} aria-expanded={attention}>{attention?'Hide issues':'View issues'} <ChevronDown size={15}/></button></section>}
    {attention && <section className="panel cps-issues"><div className="panel-head"><div><h2>Needs attention</h2><p>Correct the source, then refresh CPS.</p></div></div><div className="cps-table-wrap"><table><thead><tr><th>Issue</th><th>Station</th><th>Person / vehicle</th><th>Period</th><th>Action</th></tr></thead><tbody>{gaps.map(g=><tr key={g.key}><td><strong>{g.kind}</strong><small>{g.owner}</small></td><td>{g.station_code}</td><td>{g.name||'—'}<small>{g.dropx_id||g.provider_id}</small></td><td>{g.first_date} – {g.last_date}</td><td>{canResolve?<a className="button" href={g.href}>Open source <ArrowRight size={13}/></a>:g.owner}</td></tr>)}</tbody></table></div>{!gaps.length&&<p className="panel-body">No source issues in this selection.</p>}</section>}
    <div className="cps-section-title"><div><h2>Where the money goes</h2><p>Select a cost group to see its source and details.</p></div><span>₹ per delivered shipment</span></div>
    <section className="cps-cost-cards" aria-label="Cost groups">
      {categories.map(({head:key,label,note,icon:Icon})=><button type="button" key={key} className={`cps-cost-card ${key.toLowerCase()} ${head===key?'selected':''}`} onClick={()=>setHead(key)} aria-pressed={head===key} aria-controls="cps-cost-detail"><span><Icon size={18}/>{label}</span><strong>{money(ratio(costs[key],total.deliveries),2)}</strong><div>{money(costs[key])}<small>{total.total>0?`${(costs[key]/total.total*100).toFixed(1)}% of cost`:'No recorded cost'}</small></div><p>{note}</p></button>)}
    </section>
    <section className="panel cps-detail-panel" id="cps-cost-detail" aria-label={`${head} cost details`}>
      <div className="panel-head"><div><h2>{head} cost breakdown</h2><p>{head==='UTR'?'People CTC is accrued by calendar day for active employment dates. Attendance does not reduce this cost. Shared staff follow their assigned locations.':head==='Van'?'Rent follows dated Fleet deployments. Fuel, driver costs, repairs and approved ad hoc requests are shown separately.':head==='Other'?'Station rent comes from Finance Rent Master. Electricity and other operating expenses come from approved payments and cashbook.':'Uses the existing Dashboard workforce payment rules and provider mappings. Spot DA payments are included separately.'}</p></div><strong>{money(costs[head])}</strong></div>
      <div className="cps-table-wrap"><table><thead><tr><th>Cost item</th><th>Source</th><th>Amount</th><th>CPS</th></tr></thead><tbody>{[...bySource.values()].sort((a,b)=>b.amount-a.amount).map(r=><tr key={`${r.head}|${r.label}|${r.source}`}><td>{r.label}</td><td><span className="cps-source-tag">{r.source}</span></td><td>{money(r.amount,2)}</td><td>{money(ratio(r.amount,total.deliveries),2)}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>{head} total</th><th>{money(costs[head],2)}</th><th>{money(ratio(costs[head],total.deliveries),2)}</th></tr></tfoot></table></div>
      {!bySource.size&&<p className="panel-body">No recorded {head.toLowerCase()} costs in this period. Check the source issues above for missing setup.</p>}
      {staff.length>0 && <details className="cps-drilldown" open={head==='UTR'}><summary>People CTC details <span>{new Set(staff.map(p=>p.employee_id)).size} employees</span></summary><div className="cps-table-wrap"><table><thead><tr><th>Employee</th><th>Station</th><th>Monthly CTC</th><th>Accrued days</th><th>Allocation</th><th>Period cost</th></tr></thead><tbody>{staff.map((p,i)=><tr key={`${p.employee_id}|${p.station_code}|${i}`}><td><strong>{p.name}</strong><small>{p.employee_code} · {p.designation}</small></td><td>{p.station_code}</td><td>{money(p.monthly_ctc,2)}</td><td>{p.days}<small>{p.from_date} – {p.through_date}</small></td><td>{p.allocation==='delivery_share'?'Delivery share':'Assigned station / equal share'}</td><td>{money(p.amount,2)}</td></tr>)}</tbody></table></div></details>}
      {head==='DA' && <details className="cps-drilldown"><summary>Associate payout details <span>{snapshot.people?.length??0} station assignments</span></summary><div className="cps-table-wrap"><table><thead><tr><th>Associate</th><th>Station</th><th>Delivered</th><th>Fixed pay</th><th>Variable pay</th><th>Fuel</th><th>DA total</th></tr></thead><tbody>{(snapshot.people??[]).map(p=><tr key={`${p.id}|${p.station_code}`}><td><strong>{p.name}</strong><small>{p.dropx_id}</small></td><td>{p.station_code}</td><td>{count(p.deliveries)}</td><td>{money(p.salary,2)}</td><td>{money(p.variable,2)}</td><td>{money(p.fuel,2)}</td><td>{money(p.salary+p.variable+p.fuel,2)}</td></tr>)}</tbody></table></div><p className="cps-footnote">Spot DA requests appear in the cost breakdown above. Vehicle components are included under Van.</p></details>}
      {head==='Van' && <details className="cps-drilldown" open><summary>Vehicle rent details <span>{new Set(vehicles.map(v=>v.vehicle_id)).size} vehicles</span></summary><div className="cps-table-wrap"><table><thead><tr><th>Vehicle</th><th>Allocated station</th><th>Monthly rent</th><th>Deployed days</th><th>Period cost</th></tr></thead><tbody>{vehicles.map((v,i)=><tr key={`${v.vehicle_id}|${v.station_code}|${i}`}><td><strong>{v.vehicle_no}</strong><small>{v.model}</small></td><td>{v.station_code}</td><td>{v.monthly_rent==null?<span className="cps-missing">Setup required</span>:money(v.monthly_rent)}</td><td>{v.days}<small>{v.from_date} – {v.through_date}</small></td><td>{money(v.amount,2)}</td></tr>)}</tbody></table></div><p className="cps-footnote">Own-vehicle rent starts from 1 September 2026. Rates and future revisions are managed in <a href="https://fleet.dropxlogistics.com/fleet-control?section=masters&master=vehicle_master">Fleet → Masters → Vehicle Master</a>. Rent continues for a deployed vehicle during downtime.</p></details>}
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Station comparison</h2><p>Each cost group uses the same shipment denominator.</p></div><input className="cps-station-search" aria-label="Search station CPS" placeholder="Search station…" value={tableSearch} onChange={e=>setTableSearch(e.target.value)}/></div><div className="cps-table-wrap"><table><thead><tr>{['Station','Delivered','DA CPS','UTR CPS','Van CPS','Other CPS','Total CPS','Total cost'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{stationRows.map(s=><tr key={s.key}><td><a href={stationHref[s.key]}><strong>{s.key}</strong></a><small>{stationNames[s.key]}</small></td><td>{count(s.deliveries)}</td><td>{money(ratio(s.da,s.deliveries),2)}</td><td>{money(ratio(s.utr,s.deliveries),2)}</td><td>{money(ratio(s.van,s.deliveries),2)}</td><td>{money(ratio(s.other+s.rent+s.overhead,s.deliveries),2)}</td><td><strong>{money(s.cps,2)}</strong>{s.provisional&&<small className="cps-missing">Provisional</small>}</td><td>{money(s.total)}</td></tr>)}</tbody></table></div>{!stationRows.length&&<p className="panel-body">No stations match this search.</p>}</section>
    <details className="panel cps-drilldown"><summary>Daily trend <span>{new Set(snapshot.daily.map(d=>d.work_date)).size} days</span></summary><div className="cps-table-wrap"><table><thead><tr><th>Date</th><th>Delivered</th><th>DA</th><th>UTR</th><th>Van</th><th>Other</th><th>Total cost</th><th>CPS</th></tr></thead><tbody>{groupCps(snapshot.daily,d=>d.work_date).sort((a,b)=>b.key.localeCompare(a.key)).map(d=><tr key={d.key}><td>{d.key}</td><td>{count(d.deliveries)}</td><td>{money(d.da)}</td><td>{money(d.utr)}</td><td>{money(d.van)}</td><td>{money(d.other+d.rent+d.overhead)}</td><td>{money(d.total)}</td><td>{money(d.cps,2)}</td></tr>)}</tbody></table></div></details>
  </>;
}
