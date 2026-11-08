import Link from 'next/link';
import { betaUanProgress } from '@/lib/workforce-onboarding-evidence';
import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { requirePagePermission, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadOpsWorkforceLocations } from '@/lib/ops-workforce-locations';
import { workforceStationPolicy } from '@/lib/workforce-register-policy';
import { WorkforceLifecycleDesk } from '@/components/workforce-lifecycle-desk';
import { AmazonDaDesk } from '@/app/ops-pulse/workforce/amazon-onboarding/view';
const path='/workforce/onboarding';
const editor='https://workforce.dropxlogistics.com/delivery-network/amazon-pilot';
const human=(v:string|null|undefined)=>v?v.replaceAll('_',' '):'Not received';
const stamp=(v:string|null|undefined)=>v?new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Not received';
export type OnboardingHubParams=Record<string,string|undefined>;
export async function WorkforceOnboardingHub({params={}}:{params?:OnboardingHubParams}) {
 const auth=await requirePagePermission('delivery_associates','access'),company=requireCompanyId(auth),db=supabaseAdmin;
 if(!db)throw new Error('Workforce storage unavailable.');
 const stations=await loadOpsWorkforceLocations(company,auth);
 const tab=['amazon','lifecycle'].includes(params.tab||'')?params.tab:'joiners';
 const canEdit=hasPermission(auth,'delivery_associates','edit')&&!auth.readOnly&&!auth.isPreview;
 const canAdd=hasPermission(auth,'delivery_associates','add')&&!auth.readOnly&&!auth.isPreview;
 const scoped=stations.map(s=>s.id);
 let query=db.from('workforce_amazon_email_pilot_candidates').select('id,station_id,full_name,mobile,alias_email,biometric_id,status,inbox_status,duplicate_identity_detected,closed_at,created_at').eq('company_id',company);
 if(!auth.hasAllLocationAccess)query=query.in('station_id',scoped.length?scoped:['00000000-0000-0000-0000-000000000000']);
 if(params.station&&scoped.includes(params.station))query=query.eq('station_id',params.station);
 const page=Math.max(1,Math.min(10000,Number.parseInt(params.page||'1',10)||1));
 // Database pagination bounds the source joins. No full-mailbox fetch on page load.
 const candidates=tab==='joiners'?await query.order('created_at',{ascending:false}).range((page-1)*50,page*50):{data:[],error:null};
 const people=(candidates.data||[]).slice(0,50),more=(candidates.data||[]).length>50,ids=people.map(p=>p.id);
 const [snapshots,registrations,uanMail]=ids.length?await Promise.all([
  db.from('workforce_beta_verification_snapshots').select('candidate_id,identity_email,driver_id,operational_status,bgc_status,uan_status,learning_status,lsc_observed_at,idfy_observed_at,sync_error').eq('company_id',company).in('candidate_id',ids),
  db.from('workforce_amazon_email_pilot_registrations').select('candidate_id,status').eq('company_id',company).in('candidate_id',ids),
  db.from('workforce_amazon_email_pilot_messages').select('id,candidate_id,sender,subject,preview,received_at').eq('company_id',company).in('candidate_id',ids).or('subject.ilike.%uan%,subject.ilike.%shram%').order('received_at',{ascending:false}).limit(1000)
 ]):[{data:[],error:null},{data:[],error:null},{data:[],error:null}];
 const byId=new Map((snapshots.data||[]).map(s=>[s.candidate_id,s]));
 const regs=new Map((registrations.data||[]).map(r=>[r.candidate_id,r.status]));
 const error=candidates.error||snapshots.error||registrations.error;
 return <AppShell active="Onboarding & lifecycle" pageCode="delivery_associates"><div className="ops-command-center">
  <PageHead eyebrow="Workforce" title="Onboarding & lifecycle" subtitle="Joiners, Amazon progress and employment changes in one place."/>
  <nav className="workforce-lifecycle-tabs" aria-label="Onboarding views">
   {[['joiners','Guided onboarding'],['amazon','Amazon IDs'],['lifecycle','Lifecycle & exits']].map(([key,label])=><Link key={key} className={tab===key?'active':''} href={`${path}?tab=${key}`}>{label}</Link>)}
  </nav>
  {tab==='lifecycle'?<WorkforceLifecycleDesk/>:tab==='amazon'?<AmazonDaDesk stations={stations.filter(s=>workforceStationPolicy(s).requiresStationEmail).map(s=>({id:s.id,code:s.station_code||''}))} initialView="onboarding" initialStation={params.station} canEdit={canEdit}/>:<>
   <section className="panel"><div className="panel-body" style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
    <form action={path} style={{display:'flex',gap:8,flex:'1 1 280px'}}><select className="select" name="station" aria-label="Station" defaultValue={params.station||''}><option value="">All permitted stations</option>{stations.map(s=><option key={s.id} value={s.id}>{s.station_code}</option>)}</select><button className="button secondary">Apply</button></form>
    <Link className="button secondary" href={`${path}${params.station?`?station=${encodeURIComponent(params.station)}`:''}`}>Refresh status</Link>
    {canAdd?<a className="button" href={`${editor}?new=1#arrival`}>Add associate</a>:null}
   </div></section>
   {error?<section className="panel"><div className="panel-body" role="alert">Onboarding sources could not be loaded. Refresh to retry; no status has been changed.</div></section>:<section className="panel"><div style={{overflowX:'auto'}}><table className="table"><thead><tr><th>Associate / IDs</th><th>Station</th><th>Current progress</th><th>Source updated</th><th>Next action</th></tr></thead><tbody>
    {people.map(p=>{const observed=byId.get(p.id),matched=observed?.identity_email?.trim().toLowerCase()===p.alias_email.trim().toLowerCase(),s=matched?observed:null;
     const old=s?.lsc_observed_at?Date.now()-Date.parse(s.lsc_observed_at)>30*60000:true;
     const state=p.closed_at?'Closed':s?.operational_status?.toUpperCase()==='ACTIVE'?'Amazon active':human(regs.get(p.id)||p.status);
     const uan=betaUanProgress(s??null,(uanMail.data||[]).filter(m=>m.candidate_id===p.id));
     const uanLabel=uanMail.error||(uanMail.data||[]).length>=1000?'Check journey':uan.status==='unknown'?'Awaiting confirmation':human(uan.status);
     return <tr key={p.id}><td><strong>{p.full_name}</strong><div>{p.mobile}</div><small>Driver: {s?.driver_id||'Awaiting source'} · Biometric: {p.biometric_id}</small><details><summary>Amazon sign-in email</summary><span style={{overflowWrap:'anywhere'}}>{p.alias_email}</span><div>Inbox: {human(p.inbox_status)}</div></details></td>
      <td>{stations.find(x=>x.id===p.station_id)?.station_code||'Closed / former station'}</td><td><strong>{state}</strong>{p.duplicate_identity_detected?<div>Identity review required</div>:null}<div>Registration: {human(regs.get(p.id))}</div><small>BGC: {human(s?.bgc_status)} · UAN: {uanLabel}<br/>Learning: {human(s?.learning_status)}</small></td>
      <td><small>Amazon: {stamp(s?.lsc_observed_at)}<br/>IDfy: {stamp(s?.idfy_observed_at)}</small>{old||s?.sync_error||observed&&!matched?<div role="status">{observed&&!matched?'Identity mismatch — review required':s?.sync_error?'Source sync needs attention':'Awaiting fresh source update'}</div>:null}</td>
      <td><a className="button secondary" href={`${editor}?candidate=${encodeURIComponent(p.id)}#candidate`}>Open journey</a><small style={{display:'block',marginTop:6}}>Registration, inbox, reports and controls</small></td></tr>;
    })}
    {!people.length?<tr><td colSpan={5}>No guided onboarding records in this view.</td></tr>:null}
   </tbody></table></div><div className="panel-body" style={{display:'flex',justifyContent:'space-between'}}>{page>1?<Link href={`${path}?page=${page-1}&station=${encodeURIComponent(params.station||'')}`}>Previous</Link>:<span/>}<span>Page {page} · {people.length} associates</span>{more?<Link href={`${path}?page=${page+1}&station=${encodeURIComponent(params.station||'')}`}>Next</Link>:<span/>}</div></section>}
   <p className="subtle">Journey actions open the existing Workforce onboarding workspace. Amazon activation, registration approval and payment setup remain separate confirmations.</p>
  </>}
 </div></AppShell>;
}
