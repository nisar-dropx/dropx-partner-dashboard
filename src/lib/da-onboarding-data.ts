import {loadDASetup} from './da-onboarding-setup';
import {daDesignationCodes} from './da-onboarding-policy';
import type {SupabaseClient} from '@supabase/supabase-js';
import {allClientIdRows} from './workforce-client-id-queue';
import {betaUanProgress} from './workforce-onboarding-evidence';
import {mergeDARegistry,type GuidedDA,type DAOwner,type DALink} from './da-onboarding-registry';
import type {AmazonDaList,AmazonDaPerson} from './amazon-da-desk-types';
import {callWorkforceAmazonWorker} from './workforce-amazon-worker';
export async function loadDARegistry(db:SupabaseClient,companyId:string,stationId:string,amazonAccess:boolean,guidedAccess:boolean,includeClosed=false){
 const warnings:string[]=[];
 async function source<T>(label:string,work:()=>Promise<T[]>) {try{return await work();}catch{warnings.push(`${label} unavailable. Refresh to retry; the list may be incomplete.`);return [] as T[];}}
 async function amazon(view:string){
  const rows:AmazonDaPerson[]=[];let offset=0,snapshot='';
  for(let page=0;page<100;page++){
   const result=await callWorkforceAmazonWorker<AmazonDaList>('/api/admin/amazon/station-desk/list',{method:'POST',body:JSON.stringify({companyId,stationId,view,pageSize:100,offset,snapshot})});
   if(!Array.isArray(result.rows))throw Error('Invalid Amazon response');
   if(result.reset)throw Error('Snapshot changed');rows.push(...result.rows);if(result.checkedAt)observed.push(result.checkedAt);
   if(result.nextOffset==null)return rows;
   if(result.nextOffset<=offset)throw Error('Invalid pagination');offset=result.nextOffset;snapshot=result.snapshot;
  }throw Error('Amazon result exceeded limit');
 }
 const roles=await db.from('designations').select('id').eq('company_id',companyId).in('code',[...daDesignationCodes]);
 if(roles.error)throw Error('Designation settings unavailable');
 const roleIds=(roles.data||[]).map(r=>r.id);
 if(!roleIds.length)return {rows:[],warnings:[],checkedAt:null};
 const observed:string[]=[];
 const [onboarding,active,closed,guided,owners]=await Promise.all([
  amazonAccess?source('Amazon onboarding',()=>amazon('onboarding')):[],amazonAccess?source('Amazon associates',()=>amazon('associates')):[],amazonAccess&&includeClosed?source('Amazon history',()=>amazon('offboarded')):[],
  guidedAccess?source<GuidedDA>('System registrations',()=>allClientIdRows((from,to)=>db.from('workforce_amazon_email_pilot_candidates').select('id,full_name,alias_email,mobile,biometric_id,status,closed_at,duplicate_identity_detected,inbox_status').eq('company_id',companyId).eq('station_id',stationId).in('designation_id',roleIds).order('id').range(from,to))):[],
  source<DAOwner>('DropX owners',()=>allClientIdRows((from,to)=>db.from('workforce').select('id,full_name,dropx_id,email,onboarding_status,lifecycle_status,is_active,designation,designation_id,provider_employee_id,mobile,source_profile_type,source_profile_id').eq('company_id',companyId).eq('location_id',stationId).in('designation_id',roleIds).is('deleted_at',null).order('id').range(from,to)))
 ]);
 // A promoted invitation follows its canonical profile after a station transfer.
 // Do not leave a second invitation row behind at the former station.
 const movedInvitations=new Set<string>();
 for(let start=0;start<guided.length;start+=100){
  const batch=guided.slice(start,start+100);
  const promoted=await db.from('workforce').select('id,location_id,deleted_at').eq('company_id',companyId).in('id',batch.map(g=>g.id));
  if(promoted.error){warnings.push('Invitation ownership could not be checked. Refresh to retry.');continue;}
  for(const g of batch)if(promoted.data?.some(o=>o.id===g.id&&(o.location_id!==stationId||o.deleted_at)))movedInvitations.add(g.id);
 }
 const localGuided=guided.filter(g=>!movedInvitations.has(g.id));
 if(!amazonAccess)warnings.push('Amazon status access is not enabled for your role. Ask an administrator for Amazon DA access.');
 const links:DALink[]=[];
 for(let i=0;i<owners.length;i+=100)links.push(...await source<DALink>('Owner links',()=>allClientIdRows((from,to)=>db.from('workforce_amazon_portal_links').select('workforce_id,amazon_provider_id,transporter_id').eq('company_id',companyId).in('workforce_id',owners.slice(i,i+100).map(p=>p.id)).order('id').range(from,to))));
 for(let i=0;i<localGuided.length;i+=100){
  const batch=localGuided.slice(i,i+100),ids=batch.map(p=>p.id);
  const [s,r,m]=await Promise.all([
   db.from('workforce_beta_verification_snapshots').select('candidate_id,identity_email,amazon_profile_id,driver_id,operational_status,bgc_status,uan_status,learning_status,lsc_observed_at,sync_error').eq('company_id',companyId).in('candidate_id',ids),
   db.from('workforce_amazon_email_pilot_registrations').select('candidate_id,status').eq('company_id',companyId).in('candidate_id',ids),
   db.from('workforce_amazon_email_pilot_messages').select('id,candidate_id,sender,subject,preview,received_at').eq('company_id',companyId).in('candidate_id',ids).or('subject.ilike.%uan%,subject.ilike.%shram%').order('received_at',{ascending:false}).limit(1000)
  ]);
  if(s.error||r.error||m.error)warnings.push('Some guided progress could not be checked. Open the associate for details.');
  for(const g of batch){const snap=s.data?.find(x=>x.candidate_id===g.id);const matched=snap&&snap.identity_email?.trim().toLowerCase()===g.alias_email.trim().toLowerCase();
   g.registration=r.data?.find(x=>x.candidate_id===g.id)?.status;
   if(matched){g.driverId=snap.driver_id;g.amazonProfileId=snap.amazon_profile_id;g.amazonStatus=snap.operational_status;g.bgc=snap.bgc_status;g.learning=snap.learning_status;g.observedAt=snap.lsc_observed_at;g.syncError=snap.sync_error;g.uan=m.error||(m.data?.length||0)>=1000?'Check record':betaUanProgress(snap,(m.data||[]).filter(x=>x.candidate_id===g.id)).status;}
   else if(snap)g.syncError='Identity mismatch';
  }
 }
 const rows=mergeDARegistry([...onboarding,...active,...closed],localGuided,owners,links);
 try{await loadDASetup(db,companyId,stationId,rows);}catch{warnings.push('ID mapping and rate-card configuration could not be checked. Refresh to retry.');}
 return {rows,warnings:[...new Set(warnings)],checkedAt:observed.sort()[0]||null};
}
