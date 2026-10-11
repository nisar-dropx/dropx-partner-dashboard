import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { OpsWorkforceNavigation } from '@/components/ops-workforce-navigation';
import { requirePagePermission, isCompanyOwner } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadOpsWorkforceLocations } from '@/lib/ops-workforce-locations';
import styles from './ops-beta-verification.module.css';
const date=(value:string|null)=>value?new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}).format(new Date(value)):'Not yet';
export async function OpsBetaVerification({status='all'}:{status?:string}) {
 const auth=await requirePagePermission('delivery_associates','access');
 if(!isCompanyOwner(auth))notFound();
 const company=requireCompanyId(auth), db=supabaseAdmin;
 if(!db)throw new Error('Verification queue unavailable');
 const locations=await loadOpsWorkforceLocations(company,auth);
 const stations=new Map(locations.map(row=>[row.id,row]));
 let query=db.from('workforce_amazon_email_pilot_candidates').select('id,full_name,alias_email,station_id').eq('company_id',company);
 if(!auth.hasAllLocationAccess)query=query.in('station_id',locations.map(row=>row.id).length?locations.map(row=>row.id):['00000000-0000-0000-0000-000000000000']);
 const candidates=await query.limit(200);
 const people=new Map((candidates.data??[]).map(row=>[row.id,row]));
 const ids=[...people.keys()];
 const [cases,snapshots,policy]=await Promise.all([
  ids.length?db.from('workforce_beta_verification_cases').select('*').eq('company_id',company).in('candidate_id',ids).order('updated_at',{ascending:false}):Promise.resolve({data:[],error:null}),
  ids.length?db.from('workforce_beta_verification_snapshots').select('candidate_id,sync_error,idfy_observed_at,bgc_status,operational_status').eq('company_id',company).in('candidate_id',ids):Promise.resolve({data:[],error:null}),
  db.from('workforce_beta_verification_settings').select('auto_offboard_enabled,offboard_reason_code').eq('company_id',company).maybeSingle()
 ]);
 const snapshotById=new Map((snapshots.data??[]).map(row=>[row.candidate_id,row]));
 const labels:Record<string,string>={all:'All cases',awaiting_candidate:'Candidate action',awaiting_idfy:'With IDfy',held:'Needs review',resolved:'Cleared',offboarded:'Offboarded',offboarding:'Action in progress'};
 const visible=(cases.data??[]).filter(row=>status==='all'||row.status===status);
 return <AppShell active="Workforce Register" pageCode="delivery_associates"><PageHead eyebrow="Private beta · IDfy" title="BGC follow-up" subtitle="Corrected addresses, PCC handoffs and verification outcomes for isolated pilot candidates."/><OpsWorkforceNavigation register verification/>
  <section className={styles.policy}><strong>15-day no-response rule</strong><p>Offboard only when BGC is still failed, the candidate has not responded, and Amazon still confirms onboarding. A response, green result or activation stops the action. Unavailable or stale sources hold it for review.</p><span>{policy.data?.auto_offboard_enabled&&policy.data.offboard_reason_code?'Policy enabled · fresh checks required':'Automatic offboarding held · policy / Amazon reason needs configuration'}</span></section>
  <nav className={styles.tabs}>{Object.entries(labels).filter(([key])=>key!=='offboarding').map(([key,label])=><a aria-current={status===key?'page':undefined} key={key} href={`/work-force-register?section=bgc&status=${key}`}>{label}<b>{key==='all'?(cases.data??[]).length:(cases.data??[]).filter(row=>row.status===key).length}</b></a>)}</nav>
  {cases.error||candidates.error||snapshots.error?<p role="alert">The beta verification queue is unavailable. Refresh after the release completes.</p>:null}
  <div className={styles.list}>{visible.map(row=>{const person=people.get(row.candidate_id),source=snapshotById.get(row.candidate_id);return <article key={row.id}><header><div><small>{String((stations.get(person?.station_id) as {station_code?:string}|undefined)?.station_code??'Private beta')}</small><h2>{person?.full_name}</h2><p>{person?.alias_email}</p></div><span>{labels[row.status]??row.status}</span></header><h3>{row.label}</h3><p>{row.reason}</p><dl><div><dt>Failure notice seen</dt><dd>{date(row.failure_notified_at)}</dd></div><div><dt>Response received</dt><dd>{date(row.response_at)}</dd></div><div><dt>15-day deadline</dt><dd>{row.response_at?'Stopped — candidate responded':row.failure_notified_at?date(new Date(Date.parse(row.failure_notified_at)+15*86400000).toISOString()):'Starts when a confirmed BGC failure is shown'}</dd></div><div><dt>IDfy updated</dt><dd>{date(source?.idfy_observed_at)}</dd></div><div><dt>Amazon ID status</dt><dd>{source?.operational_status??'Not confirmed'}</dd></div><div><dt>Re-verification email</dt><dd>{row.mail_status==='sent'?`Sent ${date(row.mail_sent_at)}`:row.mail_status.replaceAll('_',' ')}</dd></div></dl>{row.current_address?<details><summary>Submitted current address</summary><p>{['house','road','locality','landmark','city','state','pin'].map(key=>row.current_address[key]).filter(Boolean).join(', ')}</p><p>Contact: {row.current_address.mobile}</p></details>:null}{row.response_note?<p>PCC handoff: {row.response_note}</p>:null}{row.last_error||source?.sync_error?<p role="status" className={styles.warning}>{row.last_error||source?.sync_error}</p>:null}<footer>Only the private beta case is updated. Payout and mapping are separate.</footer></article>;})}</div>
  {!visible.length&&!cases.error?<section className={styles.empty}><h2>No cases in this view</h2><p>Cases appear after an exact IDfy profile match reports a failed check or insufficiency.</p></section>:null}
 </AppShell>;
}
