import {supabaseAdmin} from '@/lib/supabase-admin';
import {requireCompanyId} from '@/lib/company-scope';
import {type AuthorizationContext,hasPermission} from '@/lib/authorization';
import {readAllRows} from '@/lib/supabase-pagination';
import styles from './payout-review-desk.module.css';
type Row=Record<string,any>;
const money=(v:unknown)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(v??0));
const time=(v:string)=>new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'});
export async function PayoutReviewDesk({auth,portal,action,params={}}:{auth:AuthorizationContext;portal:'workforce'|'ops';action:(form:FormData)=>Promise<void>;params?:{status?:string;q?:string;run?:string}}){
 if(!supabaseAdmin)return <p role="alert">Payout review is unavailable.</p>;
 const company=requireCompanyId(auth),scope=auth.hasAllLocationAccess?null:auth.locationScopeIds;
 const scoped=(q:any)=>scope?q.in('station_id',scope.length?scope:['00000000-0000-0000-0000-000000000000']):q;
 const [dr,cr,pr]=await Promise.all([
 readAllRows(scoped(supabaseAdmin.from('workforce_payout_disputes').select('*').eq('company_id',company)).order('created_at',{ascending:false}).order('id')),
 readAllRows(scoped(supabaseAdmin.from('workforce_payout_corrections').select('*').eq('company_id',company)).order('created_at',{ascending:false}).order('id')),
 readAllRows(scoped(supabaseAdmin.from('workforce_payout_publications').select('*').eq('company_id',company)).order('published_at',{ascending:false}).order('id'))]);
 if(dr.error||cr.error||pr.error)return <p role="alert">Payout review could not load. No changes were made.</p>;
 const pubs=(pr.data??[]) as Row[],corrections=(cr.data??[]) as Row[],all=(dr.data??[]) as Row[];
 const names=new Map(pubs.map(p=>[p.workforce_id,p.snapshot.item.worker_name+' · '+p.snapshot.item.dropx_id]));
 const ids=all.map(d=>d.id),events:Row[]=[];
 for(let offset=0;offset<ids.length;offset+=100){const r=await readAllRows(supabaseAdmin.from('workforce_payout_dispute_events').select('*').eq('company_id',company).in('dispute_id',ids.slice(offset,offset+100)).order('created_at').order('id'));if(r.error)throw new Error('Dispute history is unavailable');events.push(...(r.data??[]));}
 const latest=pubs.filter((p,i)=>!pubs.slice(0,i).some(x=>x.workforce_id===p.workforce_id&&x.payroll_run_id===p.payroll_run_id));
 const status=params.status||'open',q=(params.q||'').toLowerCase();
 const shown=all.filter(d=>(status==='all'||status==='open'&&['open','in_review'].includes(d.status)||d.status===status)&&(!params.run||d.payroll_run_id===params.run)&&(!q||String(names.get(d.workforce_id)||'').toLowerCase().includes(q)||d.reason.toLowerCase().includes(q)));
 const code=portal==='ops'?'ops_workforce_losses':'workforce_adjustments',edit=hasPermission(auth,code,'edit')&&!auth.readOnly;
 const common=(op:string)=><input name="operation" type="hidden" value={op}/>;
 return <div className={styles.desk}>
 <form method="get" className={styles.filters}><input name="q" aria-label="Search disputes" placeholder="Associate, ID or reason" defaultValue={params.q}/><select name="status" aria-label="Dispute status" defaultValue={status}>{['open','in_review','resolved','rejected','all'].map(s=><option key={s}>{s}</option>)}</select><button className="button secondary">Apply</button></form>
 <p>{all.filter(d=>['open','in_review'].includes(d.status)).length} open · {corrections.filter(c=>c.status==='pending').length} corrections awaiting review</p>
 {shown.map(d=>{const pub=pubs.find(p=>p.id===d.publication_id);return <article className={styles.card} key={d.id}>
 <header><div><h2>{names.get(d.workforce_id)||'Associate'}</h2><small>{pub?.snapshot.run.period_start} – {pub?.snapshot.run.period_end} · {d.category}</small></div><strong>{d.status.replace('_',' ')}</strong></header>
 <p>{d.reason}</p><details><summary>Conversation & history ({events.filter(e=>e.dispute_id===d.id).length})</summary>{events.filter(e=>e.dispute_id===d.id).map(e=><p key={e.id}><b>{e.actor_name}</b> · {e.portal} · {time(e.created_at)} IST<br/>{e.message}</p>)}</details>
 {edit&&['open','in_review'].includes(d.status)?<form action={action} className={styles.form}>{common('reply')}<input name="dispute_id" type="hidden" value={d.id}/><label>Response<textarea name="message" required minLength={3} maxLength={2000}/></label><label>Decision<select name="status"><option value="in_review">Under review / reply</option><option value="resolved">Resolve</option><option value="rejected">Not accepted — explain why</option></select></label><label>Applied correction<select name="correction_id"><option value="">No correction needed</option>{corrections.filter(c=>c.dispute_id===d.id&&c.status==='approved').map(c=><option key={c.id} value={c.id}>{c.kind} · {c.reason}</option>)}</select></label><button className="button">Save response</button></form>:null}
 </article>})}
 {!shown.length?<section className={styles.card}>No disputes match this view.</section>:null}
 <details className={styles.card}><summary>Corrections & approvals ({corrections.length})</summary>
 {corrections.map(c=><article key={c.id}><h3>{names.get(c.workforce_id)||'Associate'} · {c.kind} · {c.status}</h3><p>{c.reason}</p><p>{Object.entries(c.payload).map(([k,v])=>k+': '+v).join(' · ')}</p><small>Requested {time(c.created_at)} IST{c.reviewed_at?' · Reviewed '+time(c.reviewed_at)+' IST':''}</small>{c.review_remarks?<p>{c.review_remarks}</p>:null}
 {portal==='workforce'&&edit&&c.status==='pending'&&c.requested_by!==auth.userId?<form action={action} className={styles.form}>{common('review')}<input name="correction_id" type="hidden" value={c.id}/><label>Decision<select name="decision"><option value="approved">Approve correction</option><option value="rejected">Reject correction</option></select></label><label>Review reason<input name="message" required minLength={3}/></label><button className="button">Record decision</button></form>:null}</article>)}
 </details>
 {edit?<details className={styles.card}><summary>Correct a published payout</summary><p>OpsPulse proposes loss changes. Workforce independently reviews corrections, recalculates and republishes before release.</p>
 {latest.filter(p=>!params.run||p.payroll_run_id===params.run).map(p=><details key={p.id}><summary>{names.get(p.workforce_id)} · {p.snapshot.run.period_start} – {p.snapshot.run.period_end} · {money(p.snapshot.item.net_amount)}</summary>
 <form action={action} className={styles.form}>{common('propose')}<input name="run_id" type="hidden" value={p.payroll_run_id}/><input name="workforce_id" type="hidden" value={p.workforce_id}/>
 <label>Source day / deduction<select name="source_id" required>{(p.snapshot.lines||[]).map((l:Row)=><option key={l.id} value={l.source_id}>{l.work_date} · {l.provider_member_id||l.source_type} · {l.calculation_snapshot?.reason||''} · {money(l.net_amount)}</option>)}</select></label>
 <label>Correction type<select name="kind"><option value="counts">Replace activity counts</option>{portal==='ops'?<option value="loss">Revise / remove loss</option>:<><option value="tds">TDS correction</option><option value="other">Pay correction</option></>}</select></label>
 <label>Related dispute<select name="dispute_id"><option value="">None — proactive correction</option>{all.filter(d=>d.payroll_run_id===p.payroll_run_id&&d.workforce_id===p.workforce_id&&['open','in_review'].includes(d.status)).map(d=><option key={d.id} value={d.id}>{d.category} · {d.reason}</option>)}</select></label>
 <fieldset><legend>For count correction: new counts for this source row</legend>{[['totalDelivery','Delivery (includes SWA)'],['customerReturn','C-return'],['mfn','MFN'],['mfnReturn','MFN return']].map(([key,label])=><label key={key}>{label}<input name={key} type="number" min="0" max="100000" step="1"/></label>)}</fieldset>
 <label>For amount correction (₹)<input name="amount" type="number" step="0.01"/><small>Loss: replacement amount, 0 removes it. Pay/TDS: + adds pay; − deducts.</small></label>
 <label>Reason / evidence<textarea name="reason" required minLength={10} maxLength={2000}/></label><button className="button">Request correction</button>
 </form></details>)}</details>:null}
 <details className={styles.card}><summary>Published payouts & WhatsApp status</summary>{latest.map(p=><div key={p.id}><p><b>{names.get(p.workforce_id)}</b> · {p.snapshot.run.period_start} – {p.snapshot.run.period_end} · v{p.revision}<br/>Review until {time(p.review_until)} IST · WhatsApp {p.notification_status} · scheduled {time(p.notify_at)} IST{p.notification_error?' · '+p.notification_error:''}</p>{edit&&p.notification_status==='failed'?<form action={action}>{common('retry_notice')}<input name="publication_id" type="hidden" value={p.id}/><button className="button secondary">Retry failed notification</button></form>:null}{p.notification_status==='uncertain'?<small>Check WhatsApp delivery logs before taking further action. Automatic retry is disabled to prevent duplicate messages.</small>:null}</div>)}</details>
 </div>;
}
