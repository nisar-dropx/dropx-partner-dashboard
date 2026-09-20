import Link from 'next/link';
import {AppShell} from './app-shell';
import {SearchableSelect} from './searchable-select';
import {SubmitButton} from './submit-button';
import {requirePagePermission,hasPermission,isCompanyOwner} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {workforceClassification} from '@/lib/workforce-classification';
import styles from './workforce-mileage-desk.module.css';
export type MileageSearch={status?:string;station?:string;q?:string;sort?:string;page?:string;error?:string;notice?:string};
type Action=(form:FormData)=>Promise<void>;
type Person={id:string;full_name:string;dropx_id:string|null;location_id:string;onboarding_status:string;designation_id:string|null;designation:string|null};
type Station={id:string;station_code:string};
type Policy={id:string;station_id:string;name:string;rate_per_km:number;maximum_daily_km:number;effective_from:string;effective_to:string;policy_reference:string;created_by:string;created_at:string};
type Adjustment={id:string;amount:number;effective_date:string;status:string;reviewed_by:string|null;reviewed_at:string|null;review_remarks:string|null;payroll_run_id:string|null};
type Claim={id:string;workforce_id:string;station_id:string;policy_id:string;work_date:string;kilometres:number;rate_per_km:number;reference:string;evidence_reference:string;notes:string;reported_by:string;reported_at:string;adjustment:Adjustment};
const money=(value:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(value));
const time=(value:string)=>new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'});
export async function WorkforceMileageDesk({pageCode,active,path,params={},submit,createPolicy,review}:{pageCode:string;active:string;path:string;params?:MileageSearch;submit:Action;createPolicy?:Action;review?:Action}){
 const auth=await requirePagePermission(pageCode,'access'),company=requireCompanyId(auth),none='00000000-0000-0000-0000-000000000000';
 let error='',people:Person[]=[],stations:Station[]=[],policies:Policy[]=[],claims:Claim[]=[];const actors=new Map<string,string>();
 try{
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  let peopleQuery=supabaseAdmin.from('workforce').select('id,full_name,dropx_id,location_id,onboarding_status,designation_id,designation').eq('company_id',company).is('deleted_at',null).neq('migration_state','reclassified').order('full_name').order('id');
  let stationQuery=supabaseAdmin.from('stations').select('id,station_code').eq('company_id',company).order('station_code').order('id');
  let policyQuery=supabaseAdmin.from('workforce_mileage_policies').select('*').eq('company_id',company).order('effective_from',{ascending:false}).order('id');
  let claimQuery=supabaseAdmin.from('workforce_mileage_claims').select('*,adjustment:workforce_adjustments(id,amount,effective_date,status,reviewed_by,reviewed_at,review_remarks,payroll_run_id)').eq('company_id',company).order('reported_at',{ascending:false}).order('id');
  if(!auth.hasAllLocationAccess){const scope=auth.locationScopeIds.length?auth.locationScopeIds:[none];peopleQuery=peopleQuery.in('location_id',scope);stationQuery=stationQuery.in('id',scope);policyQuery=policyQuery.in('station_id',scope);claimQuery=claimQuery.in('station_id',scope);}
  const [pr,sr,polr,cr,eligible]=await Promise.all([readAllRows(peopleQuery),readAllRows(stationQuery),readAllRows(policyQuery),readAllRows(claimQuery),workforceClassification(company)]);
  if([pr,sr,polr,cr].some(r=>r.error))throw new Error('Mileage records could not be loaded. No changes were made; retry or contact an administrator.');
  people=(pr.data??[]).filter(eligible) as Person[];stations=sr.data??[];policies=polr.data??[];
  claims=(cr.data??[]).map(row=>({...row,adjustment:Array.isArray(row.adjustment)?row.adjustment[0]:row.adjustment})) as Claim[];
  const ids=[...new Set([...claims.flatMap(c=>[c.reported_by,c.adjustment?.reviewed_by]),...policies.map(p=>p.created_by)].filter((id):id is string=>Boolean(id)))];
  for(let n=0;n<ids.length;n+=100){const r=await supabaseAdmin.from('profiles').select('id,full_name').eq('company_id',company).in('id',ids.slice(n,n+100));for(const row of r.data??[])actors.set(row.id,row.full_name??row.id);}
 }catch(e){error=e instanceof Error?e.message:'Unable to load mileage.';}
 const stationNames=new Map(stations.map(s=>[s.id,s.station_code])),persons=new Map(people.map(p=>[p.id,p])),policyNames=new Map(policies.map(p=>[p.id,p.name]));
 const canSubmit=!error&&!auth.readOnly&&hasPermission(auth,pageCode,'add'),canReview=!error&&!auth.readOnly&&Boolean(review)&&isCompanyOwner(auth)&&hasPermission(auth,pageCode,'edit');
 const canConfigure=!error&&!auth.readOnly&&Boolean(createPolicy)&&isCompanyOwner(auth)&&hasPermission(auth,'workforce_rate_cards','edit');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const search=(params.q??'').trim().toLowerCase();
 const filtered=claims.filter(c=>(!params.status||c.adjustment?.status===params.status)&&(!params.station||c.station_id===params.station)&&(!search||[c.reference,c.evidence_reference,persons.get(c.workforce_id)?.full_name,persons.get(c.workforce_id)?.dropx_id].some(s=>s?.toLowerCase().includes(search))));
 if(params.sort==='oldest')filtered.reverse();
 const totalPages=Math.max(1,Math.ceil(filtered.length/25)),page=Math.min(totalPages,Math.max(1,Number.parseInt(params.page??'1',10)||1)),shown=filtered.slice((page-1)*25,page*25);
 const pageHref=(n:number)=>{const query=new URLSearchParams();for(const key of ['status','station','q','sort'] as const)if(params[key])query.set(key,params[key]!);query.set('page',String(n));return path+'?'+query;};
 return <AppShell active={active} pageCode={pageCode}><div className={styles.desk}>
  <header className={styles.header}><h1>Mileage claims</h1><p>Document distance → independent Workforce review → payroll → Finance. Only approved claims add to earnings. This is separate from fuel already included in a rate card.</p></header>
  {params.error||params.notice?<p role="status" className={styles.notice}>{params.error||params.notice}</p>:null}{error?<p role="alert" className={styles.error+' '+styles.notice}>{error}</p>:null}
  <section className={styles.panel}><h2>Station mileage policies</h2><p>Versioned, station-specific ₹/km terms and daily distance limits. An explicit effective rate card with zero included fuel is required for every mapped provider.</p>
   {canConfigure?<details open={!policies.length}><summary>Create approved policy</summary><form action={createPolicy} className={styles.form}>
    <label>Station<select name="station_id" defaultValue={stationNames.has(params.station??'')?params.station:''} required><option value="">Choose station</option>{stations.map(s=><option value={s.id} key={s.id}>{s.station_code}</option>)}</select></label>
    <label>Policy name / version<input name="name" required minLength={3} maxLength={120}/></label>
    <label>Agreed rate per kilometre (₹)<input name="rate_per_km" type="number" required min="0.01" max="1000000" step="0.01"/></label>
    <label>Maximum total kilometres per day<input name="maximum_daily_km" type="number" required min="0.01" max="10000" step="0.01"/></label>
    <label>Effective from<input name="effective_from" type="date" required/></label><label>Effective through<input name="effective_to" type="date" required/><small>At most 366 days; versions cannot overlap at a station.</small></label>
    <label>Approved terms / agreement reference<input name="policy_reference" minLength={3} maxLength={1000} required/></label>
    <div><p>Saved versions are immutable. Verify the agreed terms before saving. No claim or payment is created.</p><SubmitButton pendingText="Saving policy" confirmTitle="Save approved mileage terms?" confirmMessage="Confirm these are the station’s agreed terms. This policy version cannot be edited.">Save station policy</SubmitButton></div>
   </form></details>:null}
   {!policies.length&&!error?<p>No mileage policy configured. An owner must add approved station terms in Workforce before claims can be submitted.</p>:policies.length?<details><summary>{policies.length} policy version{policies.length===1?'':'s'}</summary><div className={styles.table}><table><thead><tr><th>Station / policy</th><th>Terms</th><th>Effective dates</th><th>Approval reference</th><th>Created</th></tr></thead><tbody>{policies.map(p=><tr key={p.id}><td>{stationNames.get(p.station_id)}<br/>{p.name}</td><td>{money(p.rate_per_km)}/km<br/>{p.maximum_daily_km} km/day limit</td><td>{p.effective_from} → {p.effective_to}</td><td>{p.policy_reference}</td><td>{actors.get(p.created_by)??p.created_by}<br/>{time(p.created_at)} IST</td></tr>)}</tbody></table></div></details>:null}
  </section>
  {canSubmit&&policies.length?<section className={styles.panel}><details><summary>Submit distance evidence</summary><form action={submit} className={styles.form}>
   <label>Station / mileage policy<select name="policy_id" required defaultValue=""><option value="">Choose approved policy</option>{policies.map(p=><option key={p.id} value={p.id}>{stationNames.get(p.station_id)} · {p.name} · {money(p.rate_per_km)}/km · {p.effective_from}–{p.effective_to}</option>)}</select></label>
   <label>Associate / DropX ID<SearchableSelect name="workforce_id" required placeholder="Search name, ID or station" options={people.filter(p=>p.onboarding_status==='active').map(p=>({value:p.id,label:(p.dropx_id??'ID pending')+' · '+p.full_name,helper:stationNames.get(p.location_id)}))}/></label>
   <label>Work date<input name="work_date" type="date" max={today} defaultValue={today} required/></label><label>Payroll posting date<input name="posting_date" type="date" defaultValue={today} required/><small>Use an open period for a late claim; retain the original work date.</small></label>
   <label>Total kilometres<input name="kilometres" type="number" min="0.01" max="10000" step="0.01" required/><small>Combine all eligible journeys for this associate and day.</small></label>
   <label>Unique claim reference<input name="reference" minLength={3} maxLength={200} required/></label><label>Distance evidence reference<input name="evidence_reference" minLength={3} maxLength={500} required placeholder="Trip log / odometer record / document reference"/></label>
   <label>Journey and verification notes<textarea name="notes" minLength={10} maxLength={1500} required/></label>
   <div><p>The amount is distance × policy rate. Submission is not verification or payment.</p><SubmitButton pendingText="Submitting evidence" confirmTitle="Submit mileage claim?" confirmMessage="A different Workforce reviewer must verify the evidence before it can enter payroll.">Submit for review</SubmitButton></div>
  </form></details></section>:null}
  <section className={styles.panel}><h2>Evidence &amp; review history</h2><form method="get" className={styles.filters}>
   <label>Search<input name="q" defaultValue={params.q??''} placeholder="Name, ID, claim or evidence"/></label>
   <label>Station<select name="station" defaultValue={params.station??''}><option value="">All accessible stations</option>{stations.map(s=><option key={s.id} value={s.id}>{s.station_code}</option>)}</select></label>
   <label>Status<select name="status" defaultValue={params.status??''}><option value="">All statuses</option>{['pending','approved','rejected','posted'].map(s=><option key={s}>{s}</option>)}</select></label>
   <label>Sort<select name="sort" defaultValue={params.sort??'newest'}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><button className="button secondary">Apply</button><Link href={path}>Reset</Link>
  </form><small>{filtered.length} matching claims · reviewed and reported times are IST</small><div className={styles.claims}>
   {shown.map(c=><article className={styles.claim} key={c.id}><div className={styles.claimHead}><div><h3>{persons.get(c.workforce_id)?.full_name??'Historical associate'} · {money(c.adjustment.amount)}</h3><small>{persons.get(c.workforce_id)?.dropx_id??c.workforce_id} · {stationNames.get(c.station_id)} · {c.reference}</small></div><span className={styles.badge}>{c.adjustment.status}</span></div>
    <dl className={styles.facts}><div><dt>Distance / policy</dt><dd>{c.kilometres} km × {money(c.rate_per_km)}/km<br/>{policyNames.get(c.policy_id)}</dd></div><div><dt>Work / payroll posting</dt><dd>{c.work_date} / {c.adjustment.effective_date}</dd></div><div><dt>Reported by</dt><dd>{actors.get(c.reported_by)??c.reported_by}<br/>{time(c.reported_at)} IST</dd></div><div><dt>Review</dt><dd>{c.adjustment.reviewed_at?<>{actors.get(c.adjustment.reviewed_by??'')??c.adjustment.reviewed_by}<br/>{time(c.adjustment.reviewed_at)} IST</>:'Awaiting independent verification'}</dd></div></dl>
    <p><strong>Evidence:</strong> {c.evidence_reference}<br/>{c.notes}</p>{c.adjustment.review_remarks?<p><strong>Reviewer’s decision:</strong> {c.adjustment.review_remarks}</p>:null}{c.adjustment.payroll_run_id?<small>Included in payroll snapshot {c.adjustment.payroll_run_id}. This does not mean Finance has paid it.</small>:null}
    {canReview&&c.adjustment.status==='pending'&&c.reported_by!==auth.userId?<form action={review} className={styles.actions}><input type="hidden" name="claim_id" value={c.id}/><label>Payroll posting date<input type="date" name="posting_date" defaultValue={c.adjustment.effective_date} min={c.work_date} required/></label><label>Evidence verification / rejection notes<textarea name="review_remarks" required minLength={10} maxLength={2000}/></label><label>Decision<select name="decision" defaultValue="" required><option value="">Choose decision</option><option value="approved">Approve evidence</option><option value="rejected">Reject claim</option></select></label><SubmitButton pendingText="Saving decision" confirmTitle="Save independent review?" confirmMessage="Confirm you have checked the distance evidence and selected the correct decision. Approved claims enter the next matching payroll snapshot.">Save review</SubmitButton></form>:c.adjustment.status==='pending'&&c.reported_by===auth.userId?<p>Another authorised owner must review your claim.</p>:null}
   </article>)}</div>{!shown.length?<p>{error?'Claim history is unavailable.':'No claims match this view.'}</p>:null}
   {totalPages>1?<nav className={styles.pages} aria-label="Mileage history pages">{page>1?<Link href={pageHref(page-1)}>Previous</Link>:null}<span>Page {page} of {totalPages}</span>{page<totalPages?<Link href={pageHref(page+1)}>Next</Link>:null}</nav>:null}
  </section>
 </div></AppShell>;
}
