'use client';
import { Fragment, useMemo, useState, useTransition, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { fixedPayChoices, fixedPayDimensions, fixedPayTotals, filterFixedPay, type FixedPayDimension, type FixedPayFilters, type FixedPayRow } from '@/lib/ops-pulse/fixed-pay-insights';
import { CpsAssociateTable } from '@/components/cps-associate-breakdown';
const labels = {region:'Region',cluster:'Cluster / AOM',code:'Station',payType:'Pay type'};
const empty = (): FixedPayFilters => ({region:[],cluster:[],code:[],payType:[]});
const money = (n:number|null) => n === null ? '—' : `₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
function Picker({dimension,options,selected,onChange}:{dimension:FixedPayDimension;options:string[];selected:string[];onChange:(s:string[])=>void}) {
  const [search,setSearch]=useState('');
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const close=(e:PointerEvent)=>{if(ref.current&&!ref.current.contains(e.target as Node))ref.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
  const visible=options.filter(v=>v.toLowerCase().includes(search.toLowerCase()));
  return <details ref={ref} className="fixed-filter" onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}><summary><small>{labels[dimension]}</small><strong>{selected.length ? selected.length === 1 ? selected[0] : `${selected.length} selected` : 'All'}</strong></summary><div className="fixed-popover"><input aria-label={`Search ${labels[dimension]}`} placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}/><button type="button" onClick={()=>onChange([])}>Clear selection</button>{visible.map(v=><label key={v}><input type="checkbox" checked={selected.includes(v)} onChange={()=>onChange(selected.includes(v)?selected.filter(s=>s!==v):[...selected,v])}/>{v}</label>)}{!visible.length && <p>No matching options</p>}<button type="button" onClick={()=>{if(ref.current)ref.current.open=false;}}>Done</button></div></details>;
}
export function FixedPayInsights({rows,from,to,today,sourceDate,canExport}:{rows:FixedPayRow[];from:string;to:string;today:string;sourceDate:string|null;canExport:boolean}) {
  const router=useRouter(), params=useSearchParams();
  const [filters,setFilters]=useState(empty),[search,setSearch]=useState(''),[view,setView]=useState<'station'|'associate'>('station');
  const [start,setStart]=useState(from),[end,setEnd]=useState(to),[pending,transition]=useTransition();
  const [sort,setSort]=useState<{key:string;descending:boolean}>({key:'cost',descending:true});
  const [page,setPage]=useState(0);
  const [expanded,setExpanded]=useState<string|null>(null);
  const filtered=useMemo(()=>filterFixedPay(rows,filters,search),[rows,filters,search]);
  const choices=useMemo(()=>Object.fromEntries(fixedPayDimensions.map(d=>[d,fixedPayChoices(rows,filters,search,d)])) as Record<FixedPayDimension,string[]>,[rows,filters,search]);
  const total=useMemo(()=>fixedPayTotals(filtered),[filtered]);
  const groups=useMemo(()=>{
    const map=new Map<string,FixedPayRow[]>();
    for(const r of filtered){const id=view==='station'?r.code:`${r.worker_id}|${r.code}`;map.set(id,[...(map.get(id)||[]),r]);}
    return [...map].map(([id,items])=>({id,items,label:view==='station'?items[0].code:items[0].name,...fixedPayTotals(items)})).sort((a,b)=>{
      const av=sort.key==='label'?a.label:a[sort.key as keyof ReturnType<typeof fixedPayTotals>];
      const bv=sort.key==='label'?b.label:b[sort.key as keyof ReturnType<typeof fixedPayTotals>];
      if(av===null)return bv===null?0:1;if(bv===null)return -1;
      const delta=typeof av==='string'?av.localeCompare(String(bv)):Number(av)-Number(bv);
      return (sort.descending?-delta:delta)||a.label.localeCompare(b.label);
    });
  },[filtered,sort,view]);
  const currentPage=Math.min(page,Math.max(0,Math.ceil(groups.length/50)-1));
  const pageRows=groups.slice(currentPage*50,(currentPage+1)*50);
  function apply(first=start,last=end){const q=new URLSearchParams(params.toString());q.set('from',first);q.set('to',last);transition(()=>router.push(`/cps/fixed-pay-da?${q}`));}
  function exportCsv(){const header=['Station','Associate','DropX ID','Region','Cluster / AOM','Pay type','Deliveries','C-returns','Fixed / MG','Variable','Fuel','DA cost','CPS','Input status'];const out=[header,...filtered.map(r=>{const t=fixedPayTotals([r]);return [r.code,r.name,r.dropx_id,r.region,r.cluster,r.payType,r.deliveries,r.customer_returns,r.salary,r.variable,r.fuel,t.cost,t.cps??'',t.pending?'Needs inputs':'Available'];})].map(row=>row.map(v=>`"${String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\uFEFF',out],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`fixed-pay-da-${from}-${to}.csv`;a.click();URL.revokeObjectURL(url);}
  const columns=[['label',view==='station'?'Station':'Associate'],['associates','DAs'],['workDays','Work days'],['deliveries','Delivered'],['returns','C-returns'],['salary','Fixed / MG'],['variable','Variable'],['fuel','Fuel'],['cost','DA cost'],['cps','CPS'],['pending','Needs inputs']];
  return <div className="ops-command-center fixed-pay-workspace"><header><div><h1>Fixed Pay DA</h1><p>Fixed and minimum-guarantee associates · {from} to {to}</p></div><button className="button secondary" disabled={pending} onClick={()=>transition(()=>router.refresh())}>{pending?'Refreshing…':'Refresh'}</button></header>
    <form className="fixed-period" onSubmit={e=>{e.preventDefault();apply();}}><label>From<input aria-label="From date" type="date" required max={end} value={start} onChange={e=>setStart(e.target.value)}/></label><label>To<input aria-label="To date" type="date" required min={start} max={today} value={end} onChange={e=>setEnd(e.target.value)}/></label><button className="button" disabled={pending}>Apply</button><button type="button" onClick={()=>apply(today,today)}>Today</button><button type="button" onClick={()=>apply(`${today.slice(0,7)}-01`,today)}>MTD</button><small>Shipment data through {sourceDate||'not available'}. Refresh loads the latest imported activity.</small></form>
    <section className="fixed-filters" aria-label="Fixed pay filters">{fixedPayDimensions.map(d=><Picker key={d} dimension={d} options={choices[d]} selected={filters[d]} onChange={values=>{setPage(0);setFilters({...filters,[d]:values});setExpanded(null);}}/>)}<input aria-label="Find associate or ID" placeholder="Associate, ID or station…" value={search} onChange={e=>{setPage(0);setSearch(e.target.value);}}/><button onClick={()=>{setFilters(empty());setSearch('');}}>Reset</button></section>
    <section className="fixed-kpis">{[['Associates',total.associates],['Shipments',total.shipments],['DA cost',money(total.cost)],['Weighted CPS',money(total.cps)],['Needs inputs',total.pending],['Cost, no shipments',total.noVolume]].map(([label,value])=><article key={label}><small>{label}</small><strong>{typeof value==='number'?value.toLocaleString('en-IN'):value}</strong></article>)}</section>
    <div className="fixed-toolbar"><div><button aria-pressed={view==='station'} onClick={()=>{setView('station');setExpanded(null);}}>Stations</button><button aria-pressed={view==='associate'} onClick={()=>{setView('associate');setExpanded(null);}}>Associates</button></div><small>{groups.length} results · Click a row for details</small>{canExport&&<button onClick={exportCsv}>Export filtered CSV</button>}</div>
    <div className="fixed-table-wrap"><table><thead><tr>{columns.map(([key,label])=><th key={key} aria-sort={sort.key===key?(sort.descending?'descending':'ascending'):'none'}><button onClick={()=>setSort({key,descending:sort.key===key?!sort.descending:true})}>{label} {sort.key===key?(sort.descending?'↓':'↑'):'↕'}</button></th>)}</tr></thead><tbody>{pageRows.map(g=><Fragment key={g.id}><tr><td><button className="fixed-row-open" aria-expanded={expanded===g.id} onClick={()=>setExpanded(expanded===g.id?null:g.id)}>{g.label} {expanded===g.id?'−':'+'}</button><small>{view==='associate'?`${g.items[0].dropx_id} · ${g.items[0].code}`:`${g.items[0].cluster} · ${g.items[0].region}`}</small></td><td>{g.associates}</td><td>{g.workDays}</td><td>{g.deliveries}</td><td>{g.returns}</td><td>{money(g.salary)}</td><td>{money(g.variable)}</td><td>{money(g.fuel)}</td><td><strong>{money(g.cost)}</strong></td><td>{money(g.cps)}{g.cps===null&&<small>{g.pending?'Needs inputs':'No shipments'}</small>}</td><td className={g.pending?'fixed-warning':''}>{g.pending||'—'}</td></tr>{expanded===g.id&&<tr><td colSpan={columns.length}><CpsAssociateTable rows={g.items}/></td></tr>}</Fragment>)}{!groups.length&&<tr><td colSpan={columns.length}>No fixed-pay associates match these filters and dates.</td></tr>}</tbody></table></div>
    <div className="fixed-toolbar"><small>{groups.length ? currentPage*50+1 : 0}–{Math.min((currentPage+1)*50,groups.length)} of {groups.length}</small><div><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><button disabled={(currentPage+1)*50>=groups.length} onClick={()=>setPage(currentPage+1)}>Next</button></div></div>
    <p className="fixed-note">CPS = (fixed/MG + variable pay + DA fuel) ÷ (deliveries + C-returns). Vehicle rent is excluded. Costs are estimates before payroll settlement; incomplete inputs show “—”, not zero CPS. Work days are distinct associate-days.</p>
  </div>;
}
