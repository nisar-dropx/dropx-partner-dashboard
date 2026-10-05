import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadCodLocations } from '@/lib/ops-pulse/cod';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadExpenseVariances } from '@/lib/expense-variance-data';
import { dateKey } from '@/lib/payment-volume';
export const dynamic = 'force-dynamic';
const money = (n: number | null) => n == null ? '—' : '₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2});
export default async function ExpenseVariancePage({searchParams}:{searchParams?:Record<string,string|undefined>}) {
 const auth=await requirePagePermission('ops_reports','access'), company=requireCompanyId(auth);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
 const from=searchParams?.from||today.slice(0,7)+'-01',to=searchParams?.to||today;
 const valid=dateKey(from)&&dateKey(to)&&from<=to&&(Date.parse(to)-Date.parse(from))/86400000<=366;
 const locations=await loadCodLocations(company,auth.locationScopeIds,auth.hasAllLocationAccess);
 const selected=searchParams?.station||'';
 const scoped=locations.locations.filter(s=>!selected||s.station_code===selected);
 let error=locations.error||(!valid?'Choose a valid range of up to 366 days.':'');
 let records:Awaited<ReturnType<typeof loadExpenseVariances>>=[];
 if(!error&&supabaseAdmin)try{records=await loadExpenseVariances(supabaseAdmin,company,scoped,from,to);}catch{error='Expense comparison could not be loaded. Please retry.';}
 const head=searchParams?.head||'',attention=searchParams?.attention||'';
 const rows=records.filter(r=>(!head||r.headCode===head)&&(!attention||(attention==='overrun'?r.overrun:r.state==='Actual pending')));
 const over=rows.filter(r=>r.overrun),matched=rows.filter(r=>!r.excluded&&r.actual!=null&&r.estimated!=null);
 const params=new URLSearchParams({type:'expense_variance',from,to,stations:selected,head,attention});
 return <AppShell active="Reports" pageCode="ops_reports"><PageHead eyebrow="OpsPulse · Cost control" title="Estimated vs actual expenses" subtitle="Saved expense estimate versus submitted actual cost. Work-date basis; all payment heads."/>
 <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:16}}><Link className="button" href="/reports">All reports</Link><a className="button primary" href={'/api/ops-pulse/reports/download?'+params}>Download Excel</a></div>
 <form className="panel" style={{display:'flex',flexWrap:'wrap',gap:12,padding:16,alignItems:'end'}}>
 <label>From<input className="field" name="from" type="date" defaultValue={from}/></label><label>To<input className="field" name="to" type="date" defaultValue={to}/></label>
 <label>Station<select className="field" name="station" defaultValue={selected}><option value="">All permitted stations</option>{locations.locations.map(s=><option key={s.id}>{s.station_code}</option>)}</select></label>
 <label>Payment head<select className="field" name="head" defaultValue={head}><option value="">All heads</option>{[...new Map(records.map(r=>[r.headCode,r.head])).entries()].map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
 <label>Attention<select className="field" name="attention" defaultValue={attention}><option value="">All requests</option><option value="overrun">Over estimate</option><option value="pending">Actual pending</option></select></label><button className="button primary">Apply</button></form>
 {error?<p role="alert">{error}</p>:<><div className="panel" style={{display:'flex',flexWrap:'wrap',gap:24,padding:16,margin:'14px 0',fontSize:13}}><Link style={{color:'#b4233e'}} href={'?'+new URLSearchParams({from,to,station:selected,attention:'overrun'})}><strong>{over.length} need attention</strong> · {money(over.reduce((sum,r)=>sum+(r.delta??0),0))} over estimate</Link><span>{rows.filter(r=>r.state==='Actual pending').length} actuals pending</span><span>Comparable estimates {money(matched.reduce((s,r)=>s+r.estimated!,0))} / actuals {money(matched.reduce((s,r)=>s+r.actual!,0))}</span></div>
 <div className="panel" style={{overflowX:'auto',padding:12}}><table style={{width:'100%',fontSize:12,borderCollapse:'collapse'}}><thead><tr>{['Date / reference','Station','Payment head','Estimate','Actual submitted','Difference','Attention'].map(h=><th key={h} style={{textAlign:'left',padding:10}}>{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.id} style={{borderTop:'1px solid #e5e7eb',background:r.overrun?'#fff5f5':undefined}}><td style={{padding:10}}>{r.date}<br/><small>{r.reference}</small></td><td>{r.station}</td><td>{r.head}</td><td>{money(r.estimated)}</td><td>{money(r.actual)}</td><td style={{color:r.overrun?'#b4233e':undefined}}>{money(r.delta)}{r.percent==null?'':` (${r.percent.toFixed(1)}%)`}</td><td>{r.state}</td></tr>)}</tbody></table>{!rows.length?<p>No requests match these filters.</p>:null}</div>
 <p className="subtle">Actual submitted is not the settled amount. Rejected, cancelled, returned and draft requests are excluded from attention totals. Legacy saved estimates may reflect earlier edits; no missing estimate is reconstructed.</p></>}
 </AppShell>;
}
