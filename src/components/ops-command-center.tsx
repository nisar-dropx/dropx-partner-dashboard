'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, Package, IndianRupee, AlertTriangle, ClipboardCheck } from 'lucide-react';
import { commandCostHref, filterCommandRows, type CommandCenterModel, type CommandPeriod } from '@/lib/ops-pulse/command-center';
import styles from '@/app/ops-pulse/command-center.module.css';
const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-IN', {maximumFractionDigits:0});
const money = (n: number | null | undefined, digits=2) => n == null ? '—' : `₹${n.toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
const date = (v:string | null) => v ? new Date(v+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'}) : 'Not received';

export function OpsCommandCenter({model:m,period,codes,canCost,canCostAttention=false,canPerformance,canReview,performanceDate,errors}: {
  model:CommandCenterModel; period:CommandPeriod; codes:string[]; canCost:boolean; canCostAttention?:boolean; canPerformance:boolean; canReview:boolean; performanceDate:string; errors:string[];
}) {
  const [filter,setFilter] = useState('all');
  const [search,setSearch] = useState('');
  const [showAll,setShowAll] = useState(false);
  const [sourcesOpen,setSourcesOpen] = useState(false);
  const revealSources = () => {setSourcesOpen(true);document.getElementById('command-sources')?.scrollIntoView({behavior:'smooth',block:'start'});};
  const costHref = (station?:string,view?:string) => commandCostHref(period,codes,station,view==='unmapped'&&!canCostAttention?'overview':view);
  const reviewHref = (station?:string) => `/ops-pulse/performance?${new URLSearchParams({view:'reviews',date:performanceDate,stations:codes.join(','),...(station?{review:station}:{})})}`;
  const perfHref = (station?:string) => `/ops-pulse/performance?${new URLSearchParams({view:'daily',date:performanceDate,stations:station || codes.join(',')})}`;
  const select = (key:string) => {setFilter(key);setShowAll(false);document.getElementById('command-stations')?.scrollIntoView({behavior:'smooth',block:'start'});};
  const matches = filterCommandRows(m.rows,search,filter);
  const shown = showAll ? matches : matches.slice(0,8);
  const maxVolume = Math.max(1,...m.trend.map(d => d.deliveries ?? 0));
  const maxCost = Math.max(1,...m.costs.map(d => Math.abs(d.amount)));
  const observed = m.observed > 0;
  return <>
    {errors.length>0 && <div className={styles.notice} role="alert">Could not load: {errors.join(', ')}. Affected metrics are unavailable, not zero. Use Refresh to retry.</div>}
    <section className={styles.metrics} aria-label="Last Mile summary">
      {canCost && <>
        <article><Package size={19}/><span>Delivered</span><strong>{observed ? number(m.total?.deliveries) : '—'}</strong><small>{observed ? `${number(m.total?.returns)} customer returns · ${date(period.from)}–${date(period.to)}` : 'Awaiting shipment imports'}</small><a href={costHref()}>Explore shipment costs <ArrowUpRight size={13}/></a></article>
        <article className={styles.primaryMetric}><IndianRupee size={19}/><span>{m.provisional ? 'Provisional CPS' : 'Cost per shipment'}</span><strong>{money(m.total?.cps)}</strong><small>{money(m.total?.total,0)} recorded cost ÷ {number(m.total?.shipments)} CPS shipments</small><button onClick={revealSources}>Where does this come from? <ArrowUpRight size={13}/></button></article>
        <article><AlertTriangle size={19}/><span>Above CPS target</span><strong>{m.total ? number(m.aboveTarget) : '—'}<em> groups</em></strong><small>{m.total ? `${m.missingTargets} ${m.missingTargets===1?"group":"groups"} without a complete target · ${m.provisional ? 'provisional costs' : 'recorded costs'}` : 'Cost source unavailable'}</small><button onClick={()=>select('cost')}>Review cost variance <ArrowUpRight size={13}/></button></article>
      </>}
      {canReview && <article><ClipboardCheck size={19}/><span>Open operational reviews</span><strong>{number(m.reviewCount)}</strong><small>Unclosed reviews dated through {date(period.to)}</small><Link href={reviewHref()}>Open Review Desk <ArrowUpRight size={13}/></Link></article>}
    </section>
    <section className={styles.priorities} aria-label="Next actions">
      <div><p className={styles.eyebrow}>ACT NEXT</p><h2>What needs your attention</h2></div>
      {canCost && <button onClick={()=>select('data')}><strong>{m.total ? number(m.dataGaps) : '—'}</strong><span>{m.dataGaps===1?"group":"groups"} with data gaps<small>Fix missing costs or shipment imports</small></span><ArrowUpRight size={18}/></button>}
      {canPerformance && <button onClick={()=>select('performance')}><strong>{number(m.performanceRisk)}</strong><span>{m.performanceRisk===1?"group":"groups"} with performance exceptions<small>{date(performanceDate)} · {m.performanceMissing} groups not fully assessed</small></span><ArrowUpRight size={18}/></button>}
      {!canCost && !canPerformance && <p>Your role’s operational tools are available above. Cost and performance metrics require their respective access.</p>}
    </section>
    {canCost && <div className={styles.visualGrid}>
      <section className={styles.panel}><header><div><h2>Daily deliveries</h2><p>{date(period.from)}–{date(period.to)} · shipment imports, not live EDD</p></div><span>{date(m.latest)} latest</span></header>
        {!observed ? <div className={styles.empty}>No shipment imports in this period. <Link href={costHref(undefined,'unmapped')}>Review source gaps →</Link></div> : <>
          <div className={styles.chartScroll}><div className={styles.volumeChart} role="img" aria-label={`Daily deliveries for ${period.from} to ${period.to}. Maximum ${number(maxVolume)}. Expand daily values for exact numbers.`}>
            <div className={styles.chartAxis}><span>{number(maxVolume)}</span><span>0</span></div>
            {m.trend.map(d=><div className={styles.column} key={d.date} title={`${date(d.date)}: ${number(d.deliveries)} deliveries · ${d.observed}/${d.expected} locations reporting`}><div className={styles.barTrack}>{d.deliveries===null ? <i className={styles.missingBar}>—</i> : <i data-partial={d.observed<d.expected} style={{height:`${d.deliveries/maxVolume*100}%`}}/>}</div><small>{d.date.slice(8)}</small></div>)}
          </div></div>
          <p className={styles.chartNote}>Solid = all locations reporting · hatched = partial · — = not received. Partial days are not comparable with complete days.</p>
          <details className={styles.details}><summary>Daily values & reporting coverage</summary><div className={styles.tableScroll}><table><thead><tr><th>Date</th><th>Delivered</th><th>Returns</th><th>CPS shipments</th><th>Reporting</th></tr></thead><tbody>{m.trend.map(d=><tr key={d.date}><td>{date(d.date)}</td><td>{number(d.deliveries)}</td><td>{number(d.returns)}</td><td>{number(d.shipments)}</td><td>{d.observed}/{d.expected}</td></tr>)}</tbody></table></div></details>
        </>}
      </section>
      <section className={styles.panel}><header><div><h2>Cost drivers</h2><p>Recorded cost · same period and locations</p></div><Link href={costHref()}>Breakdown <ArrowUpRight size={14}/></Link></header>
        {!m.total ? <div className={styles.empty}>Cost source unavailable.</div> : <div className={styles.costBars}>{m.costs.map(c=><div key={c.label}><div><span>{c.label}</span><strong>{money(c.amount,0)}</strong></div><div className={styles.costTrack}><i style={{width:`${Math.abs(c.amount)/maxCost*100}%`}}/></div><small>{money(m.total!.shipments ? c.amount/m.total!.shipments : null)} / CPS shipment{c.amount < 0 ? ' · credit' : ''}</small></div>)}</div>}
      </section>
    </div>}
    <section className={styles.panel} id="command-stations"><header><div><h2>Station priorities</h2><p>Highest attention first · {m.rows.length} station groups · only selected locations</p></div><span>{matches.length} matching</span></header>
      <div className={styles.tableFilters}><input aria-label="Search station or manager" placeholder="Search station, XPT or manager" value={search} onChange={e=>{setSearch(e.target.value);setShowAll(false);}}/><div role="group" aria-label="Filter station priorities">{[['all','All'],...(canCost?[['cost','Above target'],['data','Data gaps']]:[]),...(canPerformance?[['performance','Performance']]:[]),...(canReview?[['reviews','Open reviews']]:[])].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>{setFilter(key);setShowAll(false);}}>{label}</button>)}</div></div>
      <div className={styles.tableScroll}><table className={styles.stationTable}><thead><tr><th>Station / owner</th>{canCost&&<><th>Delivered</th><th>CPS / target</th><th>Data readiness</th></>}{canPerformance&&<th>Performance · {date(performanceDate)}</th>}<th>Next step</th></tr></thead><tbody>{shown.map(r=><tr key={r.code}><td><b>{r.code}</b><small>{r.name}</small>{r.subtitle&&<small>{r.subtitle}</small>}<small>{r.owner||'Manager not mapped'}</small></td>{canCost&&<><td>{r.observedDays ? number(r.summary?.deliveries) : '—'}<small>{r.observedDays ? `${number(r.summary?.returns)} returns` : 'No import'}</small></td><td><b>{money(r.summary?.cps)}</b><small>Target {money(r.summary?.target)}</small>{r.aboveTarget&&<small className={styles.attention}>+{money(r.summary!.gap)} / shipment</small>}{r.provisional&&<span className={styles.badge}>Provisional</span>}</td><td>{r.summary ? <><span>{r.observedDays}/{r.expectedDays} location-days</span><small>{r.gaps} cost/source issues</small></> : 'Unavailable'}</td></>}{canPerformance&&<td>{r.missed===null?'Unavailable':r.measured?`${r.missed} / ${r.measured} targets missed`:'Not assessed'}<small>{r.performanceRows ?? '—'}/{r.members.length} reports received</small></td>}<td>{canCost&&<Link href={costHref(r.code,r.gaps>0?'unmapped':'overview')}>{r.provisional?'Inspect source gaps':'Inspect costs'} <ArrowUpRight size={14}/></Link>}{canReview?<Link href={reviewHref(r.code)}>Review station{r.openReviews ? ` (${r.openReviews})` : ''} <ArrowUpRight size={14}/></Link>:canPerformance?<Link href={perfHref(r.code)}>View performance <ArrowUpRight size={14}/></Link>:null}</td></tr>)}</tbody></table></div>
      {!matches.length&&<div className={styles.empty}>No station groups match this filter.</div>}
      {matches.length>8&&<button className={styles.showMore} onClick={()=>setShowAll(!showAll)}>{showAll?'Show priority 8':`Show all ${matches.length} groups`}</button>}
    </section>
    {canCost&&<details className={styles.sources} id="command-sources" open={sourcesOpen} onToggle={e=>setSourcesOpen(e.currentTarget.open)}><summary>Sources, freshness & calculation <span>{m.provisional?'Provisional · source gaps remain':'Source checks complete'}</span></summary><div>
      <p><strong>CPS = recorded operating costs ÷ (deliveries including SWA + customer returns).</strong> Uses the same live calculation as CPS Cost overview: mapped DA payouts, People allocations, Fleet, facility rent, approved expenses, cashbook and advertising. Seller pickups / MFN are not CPS shipments.</p>
      <p>Selected period: {date(period.from)}–{date(period.to)}. Coverage: {m.observed}/{m.expected} location-days. Parent rows combine only their selected, authorized XPTs. A missing target is not ₹0; incomplete costs stay provisional.</p>
      <p>Latest shipment record: {date(m.sourceDates?.shipments ?? null)} · Fuel: {date(m.sourceDates?.fuel ?? null)} · Cashbook: {date(m.sourceDates?.cashbook ?? null)}. These are source dates, not proof that all locations are complete.</p>
      {canPerformance&&<p>Performance uses Hawkeye for {date(performanceDate)} and current configured Performance targets; zero is a valid observation. Missing reports or targets are not assessed. Open reviews include earlier unclosed dates, not only this cost period.</p>}
      <Link href={costHref()}>Open the same period and scope in CPS →</Link>
    </div></details>}
  </>;
}
