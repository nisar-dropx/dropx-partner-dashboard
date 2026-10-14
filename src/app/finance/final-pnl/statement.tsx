'use client';
import {Fragment,useState} from 'react';
import {money,type Entry,type Dimension} from '@/lib/finance/final-pnl/model';
import {entryTotals,groupEntries,modelLabel,statementGroups,type GroupBy} from '@/lib/finance/final-pnl/analysis';

type EntryProps={entries:Entry[];canEdit:boolean;onEdit:(entry:Entry)=>void};
const sum=(entries:Entry[])=>entries.reduce((n,e)=>n+e.paise,0);

/** One compact row per head; source records are rendered only after expansion. */
export function Statement({entries,canEdit,onEdit}:EntryProps){
 const [expanded,setExpanded]=useState<Set<string>>(new Set());
 const groups=statementGroups(entries);
 return <div className="fp-statement">{(['expense','income'] as const).map(side=>{
  const heads=groups.filter(g=>g.side===side);
  return <section className="fp-ledger" key={side} aria-label={side==='expense'?'Expense heads':'Income heads'}>
   <header><h3>{side==='expense'?'Expenses':'Income'}</h3><strong>{money(heads.reduce((n,g)=>n+g.paise,0))}</strong></header>
   {heads.map(g=><details className="fp-head" key={g.key} open={expanded.has(g.key)} onToggle={event=>{const open=event.currentTarget.open;setExpanded(previous=>{if(previous.has(g.key)===open)return previous;const next=new Set(previous);open?next.add(g.key):next.delete(g.key);return next;});}}>
    <summary><span>{g.head}</span><strong>{money(g.paise)}</strong></summary>
    {expanded.has(g.key)&&<HeadBreakdown entries={g.entries} canEdit={canEdit} onEdit={onEdit}/>}
   </details>)}
   {!heads.length&&<p className="fp-empty">No {side} entries recorded.</p>}
   {side==='income'&&!heads.some(g=>g.entries.some(e=>e.recovery))&&<div className="fp-zero-row"><span>Loss recovery <small>Not recorded</small></span><strong>{money(0)}</strong></div>}
  </section>;
 })}</div>;
}

/** First expand shows station totals, never a wall of repeated approvals. */
export function HeadBreakdown({entries,canEdit,onEdit}:EntryProps){
 const stations=[...new Set(entries.map(e=>e.station))].sort();
 return <div className="fp-head-body">{stations.length>1?stations.map(station=>{
  const items=entries.filter(e=>e.station===station);
  return <Disclosure key={station} label={station} amount={sum(items)}><SourceEntries entries={items} canEdit={canEdit} onEdit={onEdit}/></Disclosure>;
 }):<SourceEntries entries={entries} canEdit={canEdit} onEdit={onEdit}/>}</div>;
}

function Disclosure({label,amount,children}:{label:string;amount:number;children:React.ReactNode}){
 const [open,setOpen]=useState(false);
 return <details className="fp-breakdown" onToggle={event=>setOpen(event.currentTarget.open)}><summary><span>{label}</span><strong>{money(amount)}</strong></summary>{open&&children}</details>;
}
function sourceLabel(e:Entry){
 if(/salaries|manager share/i.test(e.head))return e.description.split(' · ').slice(0,3).join(' · ');
 if(/vehicle rent\s*[·-]/i.test(e.head))return e.head.replace(/^vehicle rent\s*[·-]\s*/i,'');
 return `${e.sourceStation||e.station} · ${e.head} · ${e.reference||e.source}`;
}
function SourceEntries({entries,canEdit,onEdit}:EntryProps){
 const [limit,setLimit]=useState(30);
 const sorted=[...entries].sort((a,b)=>a.date.localeCompare(b.date)||a.description.localeCompare(b.description));
 if(sorted.length===1)return <EntryEvidence entry={sorted[0]} canEdit={canEdit} onEdit={onEdit}/>;
 return <div className="fp-sources">{sorted.slice(0,limit).map(e=><Disclosure key={e.id} label={sourceLabel(e)} amount={e.paise}><EntryEvidence entry={e} canEdit={canEdit} onEdit={onEdit}/></Disclosure>)}{limit<sorted.length&&<button onClick={()=>setLimit(limit+30)}>Show more sources ({sorted.length-limit} remaining)</button>}</div>;
}
function EntryEvidence({entry:e,canEdit,onEdit}:{entry:Entry;canEdit:boolean;onEdit:(entry:Entry)=>void}){
 const [page,setPage]=useState(1),details=e.details??[],pages=Math.max(1,Math.ceil(details.length/31)),current=Math.min(page,pages),sourceTotal=details.reduce((n,d)=>n+d.paise,0);
 return <div className={`fp-entry-body${e.sourceChanged?' fp-review':''}`}>
  <div className="fp-source-line"><span>{e.station}{e.sourceStation!==e.station?` · from ${e.sourceStation}`:''} · {e.source}{e.modified?' · corrected':''}</span><button disabled={!canEdit||e.id.startsWith('ho-allocation:')} onClick={()=>onEdit(e)}>Edit entry</button></div>
  <p>{e.description}</p><small className="fp-muted">{e.reference} · {e.payrollMonth?`Payroll ${e.payrollMonth} · posted `:''}{e.date}</small>
  {e.id.startsWith('ho-allocation:')&&<p>Derived share. Change its monthly rule in HO & shared costs.</p>}
  {e.sourceChanged&&<p className="fp-warning">Source changed after this correction. Review the amount and allocation.</p>}
  {!!details.length&&<><div className="fp-scroll"><table className="fp-evidence-table"><thead><tr><th>Date</th><th>Source / reference</th><th>Amount</th></tr></thead><tbody>{details.slice((current-1)*31,current*31).map((d,i)=><tr key={`${d.date}:${d.reference}:${i}`}><td>{d.date}</td><td>{d.reference}<small>{d.label}</small></td><td>{money(d.paise)}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>Source total · {details.length} records</th><td>{money(sourceTotal)}</td></tr>{e.modified&&<><tr><td colSpan={2}>P&L correction</td><td>{money(e.paise-sourceTotal)}</td></tr><tr><th colSpan={2}>Included in P&L</th><td>{money(e.paise)}</td></tr></>}</tfoot></table></div>{pages>1&&<div className="fp-actions"><button disabled={current===1} onClick={()=>setPage(current-1)}>Previous records</button><small>{current} / {pages}</small><button disabled={current===pages} onClick={()=>setPage(current+1)}>Next records</button></div>}</>}
 </div>;
}

/** Spreadsheet comparison uses the same grouped entries as the two-sided P&L. */
export function ComparisonSheet({entries,dimensions,by,canEdit,onEdit}:EntryProps&{dimensions:Dimension[];by:GroupBy}){
 const [expanded,setExpanded]=useState<{key:string;column:string}|null>(null);
 const groups=groupEntries(entries,dimensions,by),heads=statementGroups(entries),totals=entryTotals(entries);
 const missingIncome=(items:Entry[])=>[...new Set(items.filter(e=>e.side==='expense').map(e=>e.station))].some(station=>!items.some(e=>e.station===station&&e.side==='income'&&!e.recovery));
 const label=(key:string)=>by==='model'?modelLabel(key):key;
 const toggle=(key:string,column='')=>setExpanded(previous=>previous?.key===key&&previous.column===column?null:{key,column});
 const selected=expanded?heads.find(g=>g.key===expanded.key):null;
 const selectedEntries=selected?.entries.filter(e=>!expanded?.column||groups.find(g=>g.key===expanded.column)?.entries.includes(e))??[];
 if(!heads.length)return <p className="fp-empty">No recorded entries match these filters.</p>;
 return <div className="fp-sheet-scroll"><table className="fp-sheet"><caption>Amounts in ₹ · Click a cost head or amount to expand · — means no recorded entry · Operating result is before corporate HO and unallocated regional HO</caption><thead><tr><th>Particulars</th><th>Total</th>{groups.map(g=><th key={g.key}>{label(g.key)}<small>{g.stations.length} station{g.stations.length!==1?'s':''}</small>{missingIncome(g.entries)&&<small className="fp-pending">Income incomplete</small>}</th>)}</tr></thead><tbody>
  {(['expense','income'] as const).map(side=><Fragment key={side}>
   <tr className="fp-sheet-section"><th colSpan={groups.length+2}>{side==='expense'?'Expenses':'Income'}</th></tr>
   {heads.filter(g=>g.side===side).map(head=><Fragment key={head.key}><tr>
    <th><button aria-expanded={expanded?.key===head.key} onClick={()=>toggle(head.key)}>{expanded?.key===head.key?'▾':'▸'} {head.head}</button></th>
    <td><button aria-label={`${head.head} total details`} onClick={()=>toggle(head.key)}>{money(head.paise)}</button></td>
    {groups.map(g=>{const items=head.entries.filter(e=>g.entries.includes(e));return <td key={g.key}>{items.length?<button aria-label={`${head.head} ${label(g.key)} details`} onClick={()=>toggle(head.key,g.key)}>{money(sum(items))}</button>:'—'}</td>;})}
   </tr>{expanded?.key===head.key&&<tr className="fp-sheet-expanded"><td colSpan={groups.length+2}><div className="fp-section-head"><h3>{head.head} · {expanded.column?label(expanded.column):'All selected'} · {money(sum(selectedEntries))}</h3><button onClick={()=>setExpanded(null)}>Close detail</button></div><HeadBreakdown key={`${head.key}:${expanded.column}`} entries={selectedEntries} canEdit={canEdit} onEdit={onEdit}/></td></tr>}</Fragment>)}
   <tr className="fp-sheet-total"><th>Total {side==='expense'?'expenses':'income'}</th><td>{money(totals[side])}</td>{groups.map(g=><td key={g.key}>{money(g[side])}</td>)}</tr>
  </Fragment>)}
 </tbody><tfoot><tr><th>Operating profit / loss</th><td className={totals.profit<0?'fp-loss':'fp-gain'}>{money(totals.profit)}{missingIncome(entries)&&<small>Income incomplete</small>}</td>{groups.map(g=><td key={g.key} className={g.profit<0?'fp-loss':'fp-gain'}>{money(g.profit)}{missingIncome(g.entries)&&<small>Income incomplete</small>}</td>)}</tr></tfoot></table></div>;
}
