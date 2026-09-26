import {CodSlipCheckDetails} from '@/components/cod-slip-check-details';
import {CodMailboxCheck} from '@/components/cod-mailbox-check';
import {CodExceptionDetails,CodHistory} from '@/components/cod-proof-details';
import {loadCodHistory} from '@/lib/ops-pulse/cod-proof-history';
import {proofTone} from '@/lib/ops-pulse/cod-proof-policy';
import {CodAgeingReport} from '@/components/cod-ageing-report';
import {loadCodAgeing} from '@/lib/ops-pulse/cod-ageing-data';
import Link from 'next/link';
import {redirect} from 'next/navigation';
import {canAccessDailyCodPending} from '@/lib/ops-pulse/cod-pending-access';
import {Fragment} from 'react';
import {PageHead} from '@/components/page-head';
import {CodSectionTabs} from '@/components/cod-section-tabs';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {todayKolkata,formatAmount,formatDate,formatDateTime} from '@/lib/ops-pulse/cod';
import {loadCodPendingReport} from '@/lib/ops-pulse/cod-pending-data';
import {filterCodPendingRows,pendingStatuses,validReportDate,hasSlipProof,type CodPendingRow} from '@/lib/ops-pulse/cod-pending';
export const dynamic='force-dynamic';
type Params={date?:string;location?:string;client?:string;status?:string;detail?:string};
export default async function CodPendingPage({searchParams={}}:{searchParams?:Params}){
 const auth=await requirePagePermission('cod_reports','access'),company=requireCompanyId(auth);
 if(!canAccessDailyCodPending(auth))redirect('/unauthorized?page=cod_pending&reason=access');
 const date=searchParams.date||todayKolkata(),status=searchParams.status||'all';
 let rows:CodPendingRow[]=[],error='';
 try{if(!validReportDate(date))throw new Error('Choose a valid deposit date.');if(!supabaseAdmin)throw new Error('Database unavailable.');rows=await loadCodPendingReport(supabaseAdmin,company,auth.locationScopeIds,auth.hasAllLocationAccess,date);}catch(e){console.error('COD pending report failed',e);error=validReportDate(date)?'The complete report could not be loaded. Please retry; no partial totals are shown.':'Choose a valid deposit date.';}
 const scoped=filterCodPendingRows(rows,{...searchParams,status:'all'}),visible=filterCodPendingRows(scoped,{status});
 const ageing=!error&&supabaseAdmin&&scoped.some(r=>r.client==='amazon')?await loadCodAgeing(supabaseAdmin,company,date,scoped.filter(r=>r.client==='amazon').map(r=>r.station.station_code)):null;
 const history=await loadCodHistory(company,visible.flatMap(r=>r.entries.map(s=>s.id)),visible.flatMap(r=>r.exception?[r.exception.id]:[]));
 const query=new URLSearchParams({date,status,...(searchParams.location?{location:searchParams.location}:{}),...(searchParams.client?{client:searchParams.client}:{})});
 const amount=(value:number|null)=>value===null?'Not available':`₹${formatAmount(value)}`;
 return <>
 <PageHead eyebrow="Ops Pulse" title="Daily COD Review" subtitle="Daily slips, validation results and exception updates. Deadline: 8:30 PM IST. Open a station for proof and history."/>
 <CodSectionTabs active="pending"/>
 <section className="panel"><div className="panel-body"><form action="/cod/pending" className="form-grid four">
 <label>Deposit date<input className="field" name="date" type="date" required defaultValue={date}/></label>
 <label>Station<select className="field" name="location" defaultValue={searchParams.location||''}><option value="">All permitted COD stations</option>{rows.map(r=><option value={r.station.id} key={r.station.id}>{r.station.station_code} - {r.station.station_name}</option>)}</select></label>
 <label>Client<select className="field" name="client" defaultValue={searchParams.client||''}><option value="">All clients</option><option value="amazon">Amazon</option><option value="flipkart">Flipkart</option></select></label>
 <label>Status<select className="field" name="status" defaultValue={status}><option value="pending">Pending / needs attention</option><option value="all">All stations · uploaded and pending</option><option value="uploaded">Slip uploaded</option><option value="not_uploaded">Slip not uploaded</option>{pendingStatuses.map(s=><option key={s}>{s}</option>)}</select></label>
 <div className="form-actions span-4"><button className="button primary" type="submit">Show daily report</button>{!error?<a className="button secondary" href={'/api/ops-pulse/cod/pending/export?'+query}>Download CSV</a>:null}{hasPermission(auth,'ops_notification_settings','access')?<><Link className="button secondary" href="/settings/notifications#cod-pending">Email schedule</Link><CodMailboxCheck/></>:null}</div>
 </form></div></section>
 {error?<section className="panel message-panel error"><div className="panel-body" role="alert">{error}</div></section>:<>
 <section className="panel"><div className="panel-body" style={{display:'flex',flexWrap:'wrap',gap:32}}>{[['Stations',scoped.length],['Slip uploaded',scoped.filter(r=>r.slipUploaded).length],['No daily update',scoped.filter(r=>!r.updateRecorded).length],['Exceptions recorded',scoped.filter(r=>!r.entries.length&&r.exception).length],['Needs attention',scoped.filter(r=>r.pending).length],['Complete',scoped.filter(r=>!r.pending).length],['Known shortage',amount(scoped.reduce((n,r)=>n+r.short,0))]].map(([label,value])=><div key={label}><div className="subtle">{label}</div><strong style={{fontSize:24}}>{value}</strong></div>)}</div></section>
 <section className="panel"><div className="panel-head"><div><h2>Station slip status · {formatDate(date)}</h2><p className="subtle">Deadline: {formatDate(date)}, 8:30 PM IST · Reminders: 8:30 PM that day and 9:00 AM next day. Status reflects the latest saved data.</p></div><span className="count-badge">{visible.length} stations</span></div>
 <div className="table-wrap"><table><thead><tr><th>Station / details</th><th>Client</th><th>Slip uploaded</th><th>Daily update</th><th>Slip validation</th><th>Deposited</th><th>Short</th><th>Last upload</th></tr></thead><tbody>
 {visible.map(row=><Fragment key={row.station.id}><tr><td style={{minWidth:280}}><details><summary style={{cursor:'pointer',fontWeight:700}}>{row.station.station_code} - {row.station.station_name||'Station'}</summary><div style={{padding:'16px 0',maxWidth:650,whiteSpace:'normal'}}>
 <p><strong>Deposit date:</strong> {formatDate(date)} · <strong>Portal validated:</strong> {amount(row.expected)}</p><p><strong>Excess:</strong> {amount(row.excess)}{row.duplicates?` · ${row.duplicates} duplicate remittance entries excluded from totals; review required.`:''}</p>
 {!row.entries.length&&!row.exception?<p>No COD submission exists for this station and deposit date. Upload a slip with this deposit date, including when correcting it the next morning.</p>:row.entries.map(s=><div key={s.id} style={{borderTop:'1px solid #e2e8f0',padding:'12px 0'}}><strong>{s.remittance_code||s.reference_no||'No remittance code'} · {s.validation_status}</strong><p>COD period: {formatDate(s.cod_period_from||s.cod_date)} to {formatDate(s.cod_period_to||s.cod_period_from||s.cod_date)}</p><p>Deposited: ₹{formatAmount(s.deposited_amount)} · Portal amount: {s.validated_amount==null?'Not available':`₹${formatAmount(s.validated_amount)}`}</p><p>Uploaded by {s.submitter_name||'—'} · {formatDateTime(s.created_at)}</p><p>{s.validation_remarks||s.remarks||'No remarks recorded.'}</p><p style={{color:proofTone(s.ai_status||'')==='bad'?'#b91c1c':undefined}}><strong>{s.ai_status==='Checking'?'Validation pending':s.ai_status||'Validation pending'}</strong> · {s.ai_summary||'Awaiting slip check'}</p><CodSlipCheckDetails result={s.ai_result} checkedAt={s.proof_checked_at} amount={s.deposited_amount} date={s.deposit_date} station={row.station.station_code} reference={s.remittance_code||s.reference_no||''}/><CodHistory rows={history.rows.filter(h=>h.submission_id===s.id)} error={history.error}/>{hasSlipProof(s)?<a className="button secondary" target="_blank" rel="noreferrer" href={'/api/ops-pulse/cod/submissions/slip?id='+encodeURIComponent(s.id)}>View deposit slip</a>:<strong>Deposit proof is missing.</strong>}</div>)}
 {row.exception?<div style={{borderTop:'1px solid #e2e8f0',paddingTop:12}}><strong>{row.exception.kind}{row.entries.length?' · Earlier exception record':''}</strong><CodExceptionDetails item={row.exception}/><CodHistory rows={history.rows.filter(h=>h.exception_id===row.exception!.id)} error={history.error}/></div>:null}
 <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>{hasPermission(auth,'cod_submission','access')?<Link className="button primary" href={`/cod/submission?deposit_date=${date}&location=${row.station.id}&client=${row.client}`}>Upload / correct slip</Link>:null}<a className="button secondary" href={'/api/ops-pulse/cod/pending/export?'+new URLSearchParams({date,location:row.station.id,status:'all'})}>Download station report</a></div></div></details></td><td>{row.client==='amazon'?'Amazon':'Flipkart'}</td><td><span className={`status-pill ${row.slipUploaded?'good':'warn'}`}>{row.slipUploaded?'Yes — uploaded':row.exception&&!row.entries.length?'Exception recorded':'No — pending'}</span></td><td><span className={`status-pill ${proofTone(row.validation)==='bad'?'bad':row.pending?'warn':'good'}`}>{row.status}</span><div className="subtle">{row.overdue?'Overdue':row.pending?'Due by 8:30 PM':''}{row.late?' · Uploaded late':''}</div>{row.exception?.kind==='Banker Not Reported'&&!row.entries.length?<span className={`status-pill ${['Email not found','Email check unavailable'].includes(row.exception.email_check_status)?'bad':row.exception.email_check_status==='Email confirmed'?'good':'warn'}`}>{row.exception.email_check_status}</span>:null}</td><td style={{minWidth:220,whiteSpace:'normal'}}><span className={`status-pill ${proofTone(row.validation)}`}>{row.validation}</span><p style={{color:proofTone(row.validation)==='bad'?'#b91c1c':undefined}}>{row.validationReason}</p></td><td>{amount(row.amount)}</td><td>{row.short?amount(row.short):row.status==='Short'?'Amount not available':'—'}</td><td>{row.last?formatDateTime(row.last):'No upload'}</td></tr></Fragment>)}
 {!visible.length?<tr><td colSpan={8}>{!scoped.length?'No active COD stations in this scope.':'No stations match the selected status.'}</td></tr>:null}
 </tbody></table></div><div className="panel-body"><p className="subtle">Includes active, visible Amazon and Flipkart COD stations. Office and test locations are excluded. Amounts use the deposit date; covered COD periods remain on each slip. Missing uploads have no assumed shortage. Known shortages compare deposited and portal-validated amounts. Duplicate remittance codes count once and remain flagged for review.</p></div></section></>}
 {ageing?<CodAgeingReport source={ageing} date={date} location={searchParams.location} detail={searchParams.detail}/>:null}
 </>;
}
