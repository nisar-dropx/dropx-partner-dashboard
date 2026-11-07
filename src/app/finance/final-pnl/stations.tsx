'use client';
import {Fragment,useState} from 'react';
import {money,type Entry,type Loss} from '@/lib/finance/final-pnl/model';
import {modelLabel} from '@/lib/finance/final-pnl/analysis';
import {buildStationSummary} from '@/lib/finance/final-pnl/station-summary';
import {allocatedCorporate,currentRevenue,currentDirectExpenses,stationAlerts} from '@/lib/finance/final-pnl/presentation';
import {Statement} from './statement';
import {PnlAlerts} from './alerts';

type StationRow=ReturnType<typeof buildStationSummary>['rows'][number];
export function StationResults({rows,losses,month,canEdit,onEdit,onOpen,onLosses}:{rows:StationRow[];losses:Loss[];month:string;canEdit:boolean;onEdit:(e:Entry)=>void;onOpen:(code:string)=>void;onLosses:(code:string)=>void}){
 const [expanded,setExpanded]=useState<string|null>(null),[by,setBy]=useState<'station'|'model'>('station');
 const groups=by==='station'?rows.map(row=>({key:row.station,label:row.station,rows:[row]})):[...new Set(rows.map(r=>r.dimension.model))].sort().map(model=>({key:model,label:modelLabel(model),rows:rows.filter(r=>r.dimension.model===model)}));
 const sum=(items:StationRow[],get:(r:StationRow)=>number)=>items.reduce((n,r)=>n+get(r),0);
 const alerts=(items:StationRow[])=>[...new Set(items.flatMap(stationAlerts))];
 const values=(items:StationRow[])=>{
  const net=sum(items,r=>r.net),loss=sum(items,r=>r.chargebacks),recovery=sum(items,r=>r.recovery);
  return <><td>{money(sum(items,currentRevenue))}<small>Loss incurred {money(-loss)}</small></td><td>{money(sum(items,currentDirectExpenses))}<small>Loss recovery {money(-recovery)}</small></td><td>{money(sum(items,r=>r.regionalHo))}</td><td>{money(sum(items,allocatedCorporate))}</td><td className={net<0?'fp-loss':'fp-gain'}><strong>{money(net)}</strong></td></>;
 };
 return <section className="fp-panel fp-station-overview"><div className="fp-section-head"><div><h2>Location-wise P&L</h2><p>Current results from recorded data. Open alerts for missing sources, accruals or HO still to allocate.</p></div><label>Show rows by<select value={by} onChange={e=>{setBy(e.target.value as 'station'|'model');setExpanded(null);}}><option value="station">Station</option><option value="model">Business model</option></select></label></div>
 <div className="fp-sheet-scroll"><table className="fp-station-table"><caption>₹, excluding GST · Revenue is after loss debits; direct expenses are after confirmed recovery. HO columns show allocated amounts only.</caption><thead><tr><th>{by==='station'?'Station / model':'Business model'}</th><th>Revenue after losses</th><th>Direct expenses after recovery</th><th>Regional HO allocated</th><th>Corporate HO allocated</th><th>Current P&L</th><th>Alerts</th></tr></thead><tbody>{groups.map(g=>{
  const open=expanded===g.key;
  return <Fragment key={g.key}><tr className={open?'fp-station-selected':''}><th><button aria-expanded={open} onClick={()=>setExpanded(open?null:g.key)}>{open?'▾':'▸'} {g.label}</button><small>{by==='station'?`${g.rows[0].dimension.name} · ${modelLabel(g.rows[0].dimension.model)}`:`${g.rows.length} stations`}</small></th>{values(g.rows)}<td><PnlAlerts label={g.label} issues={alerts(g.rows)}/></td></tr>
   {open&&<tr className="fp-station-expanded"><td colSpan={7}>{g.rows.map(row=><section key={row.station} className="fp-station-detail"><div className="fp-section-head"><div><h3>{row.station} · {row.dimension.name}</h3><p>{row.dimension.region} · {modelLabel(row.dimension.model)} · {month}</p>{!!row.dimension.sourceCodes?.some(code=>code!==row.station)&&<small>Includes XPT: {row.dimension.sourceCodes.filter(code=>code!==row.station).join(', ')} · one base-station P&L</small>}</div><div className="fp-actions"><PnlAlerts label={`${row.station} sources`} issues={stationAlerts(row)}/><button onClick={()=>onLosses(row.station)}>Losses & recovery</button><button onClick={()=>onOpen(row.station)}>Open station</button></div></div><StationBridge row={row}/><LossImpact row={row}/><Statement dimensions={[row.dimension]} entries={[...row.entries,...row.corporateEntries]} canEdit={canEdit} onEdit={onEdit}/><LossPosition losses={losses.filter(l=>l.station===row.station)} month={month}/></section>)}</td></tr>}
  </Fragment>;
 })}</tbody>{!!rows.length&&<tfoot><tr><th>Selected total · {rows.length} stations</th>{values(rows)}<td><PnlAlerts label="Selected stations" issues={alerts(rows)}/></td></tr></tfoot>}</table></div>{!rows.length&&<p className="fp-empty">No active stations match these filters.</p>}
 <p className="fp-muted">Current P&L = revenue after losses − direct expenses after recovery − allocated regional and corporate HO. Missing amounts are explained in alerts.</p></section>;
}

export function StationBridge({row}:{row:StationRow}){return <div className="fp-station-bridge"><span>Revenue after losses <b>{money(currentRevenue(row))}</b></span><span>Direct expenses after recovery <b>{money(currentDirectExpenses(row))}</b></span><span>Regional HO allocated <b>{money(row.regionalHo)}</b></span><span>Corporate HO allocated <b>{money(allocatedCorporate(row))}</b></span><span className="fp-bridge-net">Current P&L <b>{money(row.net)}</b></span></div>;}
export function LossPosition({losses,month}:{losses:Loss[];month:string}){
 const archived=losses.filter(l=>l.sourcePresent===false).length;losses=losses.filter(l=>l.sourcePresent!==false&&(l.finalRecoverable===undefined||l.finalRecoverable===true)&&(l.recognitionMonth===undefined||l.recognitionMonth===month));
 const pendingKnown=losses.filter(l=>l.id.startsWith('nl:')).every(l=>l.pendingPayrollThisMonthPaise!==undefined);
 const total=losses.reduce((n,l)=>n+l.paise,0),recovered=losses.reduce((n,l)=>n+l.postedPaise,0),planned=losses.reduce((n,l)=>n+l.plannedPaise,0),pending=losses.reduce((n,l)=>n+(l.pendingPayrollThisMonthPaise??0),0);
 return <details className="fp-loss-position"><summary>Ops Pulse loss position · {losses.length} cases <span>Marked {money(total)} · recovered to date {money(recovered)}</span></summary><p>Final recoverable losses assigned to P&L {month}. These cases already reduce revenue once. Confirmed recovery reduces expenses in its payroll or receipt month; assigning recovery to a person does not mean it has been collected. {archived>0?`${archived} archived source cases remain in the loss register and are excluded from these active-case totals.`:""}</p><div className="fp-station-bridge"><span>Marked losses<b>{money(total)}</b></span><span>Assigned recovery<b>{money(planned)}</b></span><span>Payroll {month} awaiting confirmation<b>{pendingKnown?money(pending):'Refresh payroll evidence'}</b></span><span>Confirmed to date<b>{money(recovered)}</b></span><span>Unrecovered balance<b>{money(losses.reduce((n,l)=>n+Math.max(0,l.paise-l.postedPaise),0))}</b></span></div></details>;
}

export function LossImpact({row}:{row:StationRow}){return <details className="fp-loss-position"><summary>Loss impact in this P&L <span>Station losses {money(row.chargebacks)} − confirmed recovery {money(row.recovery)} = {money(row.chargebacks-row.recovery)}</span></summary><p>Package / shipment debits {money(row.lossBreakdown.package)} · COD / cash debits {money(row.lossBreakdown.cod)} · other or unclassified chargebacks {money(row.lossBreakdown.other)}. Final recoverable NL/SLP cases follow their responsible station and billing month. Bundled invoice loss lines are retained for reconciliation and are not charged again. Recoveries can relate to earlier incidents.</p></details>;}
