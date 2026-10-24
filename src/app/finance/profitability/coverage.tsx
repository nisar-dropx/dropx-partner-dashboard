import type { PnlReport } from '@/lib/finance/pnl';

const date = (value: string | null) => value ? new Date(value+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}) : 'No reported data';
const money = (value:number) => '₹'+value.toLocaleString('en-IN',{maximumFractionDigits:2});
export function ShipmentCoverage({coverage,hasNow=false,corporateThrough,deferredHo=0}:{coverage:PnlReport['coverage'];hasNow?:boolean;corporateThrough?:string;deferredHo?:number}) {
  if (!coverage.length) return hasNow ? <p className="pnl-cutoff">Amazon Now uses its entered monthly UPD and reporting date. The previous-day shipment cutoff does not apply to Amazon Now.</p> : null;
  const delayed=coverage.filter(c=>c.missingDates.length), dates=[...new Set(coverage.map(c=>c.through).filter((d):d is string=>Boolean(d)))].sort();
  const noData=coverage.filter(c=>!c.through).length, excluded=coverage.reduce((s,c)=>s+c.excludedDays,0), sourceCost=coverage.reduce((s,c)=>s+c.excludedSourceCost,0);
  const range=dates.length ? dates[0]===dates.at(-1) ? date(dates[0]) : `${date(dates[0])} – ${date(dates.at(-1)!)}` : 'No shipment data in the selected period';
  return <section className={`pnl-cutoff pnl-shipment-coverage${delayed.length?' is-delayed':''}`} aria-label="Shipment data coverage">
    <div role="status"><strong>{delayed.length?'Shipment data delayed or incomplete':'Shipment dates aligned'}</strong><p>Selected through <b>{date(coverage[0].requestedTo)}</b> · Shipment P&L allowed through <b>{date(coverage[0].limit)}</b> (no later than yesterday, IST).</p>
    <p><b>{dates.length?'Calculated through: ':''}{range}</b>{noData>0?` · ${noData} station${noData===1?'':'s'} without data in this period`:''}. {delayed.length>0?`${delayed.length} of ${coverage.length} source stations have missing shipment dates. `:''}Revenue and direct costs are included only for the same reported dates; missing days are excluded from both sides. Reported zero deliveries are included.</p>
    {coverage.length===1&&coverage[0].availableThrough&&coverage[0].availableThrough!==coverage[0].through&&<p>Latest shipment data available: <b>{date(coverage[0].availableThrough)}</b>.</p>}
    {hasNow&&<p>Amazon Now keeps its own monthly UPD and reporting-date logic.</p>}
    {corporateThrough&&<p>Corporate HO is a separate business cost accrued through {date(corporateThrough)}; it is not part of the station comparison.</p>}
    {deferredHo!==0&&<p>{money(deferredHo)} regional HO is excluded pending shipment data for its recipient dates.</p>}</div>
    <details><summary>Station coverage · {coverage.length} sources{excluded?` · ${excluded} excluded station-days`:''}</summary>
    <p>Excluded recorded source costs: <b>{money(sourceCost)}</b>. These remain recorded costs, not savings. This amount excludes Finance contracts and HO. Fixed costs use calendar-day accrual; a later refresh includes dates once shipment data arrives.</p>
    <div className="pnl-scroll"><table><thead><tr><th>Source station</th><th>Latest data available</th><th>Included through</th><th>Reported days</th><th>Missing dates</th><th>Today excluded</th><th>Recorded cost excluded</th></tr></thead><tbody>{coverage.map(c=><tr key={c.station}><th scope="row">{c.station}</th><td>{date(c.availableThrough)}</td><td>{date(c.through)}</td><td>{c.reportedDays}</td><td>{c.missingDates.length?<details><summary>{c.missingDates.length} days</summary>{c.missingDates.map(d=>date(d)).join(', ')}</details>:'None'}</td><td>{c.currentDaysExcluded?'Yes':'—'}</td><td>{money(c.excludedSourceCost)}</td></tr>)}</tbody></table></div></details>
  </section>;
}
