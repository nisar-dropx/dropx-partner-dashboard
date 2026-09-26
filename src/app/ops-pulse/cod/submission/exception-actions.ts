'use server';
import {randomUUID} from 'crypto';
import {revalidatePath} from 'next/cache';
import sharp from 'sharp';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {validReportDate} from '@/lib/ops-pulse/cod-pending';
import {CONTROL_TOWER_CC,emailList} from '@/lib/ops-pulse/cod-proof-policy';
import {uploadOpsProof} from '@/lib/ops-pulse/upload';
import {inferFormTypeFromLocation,todayKolkata} from '@/lib/ops-pulse/cod';
import type {CodException} from '@/lib/ops-pulse/cod-exceptions';
export type ExceptionState={ok:boolean;error?:string;notice?:string};
export async function recordCodException(_prev:ExceptionState|null,form:FormData):Promise<ExceptionState>{
 try{
  const existingId=String(form.get('id')||'');
  const auth=await requirePagePermission('cod_submission',existingId?'edit':'add');const company=requireCompanyId(auth);
  if(auth.readOnly||auth.isPreview)throw new Error('Preview is read-only.');
  if(!supabaseAdmin)throw new Error('Database unavailable.');
  const location=String(form.get('location_id')||''),date=String(form.get('report_date')||''),kind=String(form.get('kind')||''),reason=String(form.get('reason')||'').trim();
  if(!validReportDate(date)||date>todayKolkata())throw new Error('Choose today or an earlier report date.');
  if(!['No Cash','Banker Not Reported'].includes(kind))throw new Error('Choose a valid update.');
  if(reason.length<3||reason.length>2000)throw new Error('Enter a reason between 3 and 2,000 characters.');
  if(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(location))throw new Error('Station access denied.');
  const station=await supabaseAdmin.from('stations').select('id,station_code,station_name,providers(code,name),location_models(code,name)').eq('company_id',company).eq('id',location).eq('is_active',true).maybeSingle();
  if(station.error||!station.data||!inferFormTypeFromLocation(station.data))throw new Error('Choose an active COD station.');
  let prior:CodException|null=null;
  if(existingId){const result=await supabaseAdmin.from('cod_daily_exceptions').select('*').eq('company_id',company).eq('id',existingId).eq('location_id',location).eq('report_date',date).maybeSingle();if(result.error||!result.data)throw new Error('Update not found.');prior=result.data as CodException;if(prior.version!==Number(form.get('version')))throw new Error('This update changed. Reload before editing.');}
  const id=existingId||randomUUID();
  let proof=kind==='No Cash'&&prior?.kind==='No Cash'?prior.proof:null;
  if(kind==='No Cash'){
   const file=form.get('erp_proof');
   if(file instanceof File&&file.size){
    if(file.size>10*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('ERP screenshot must be JPG, PNG or WEBP, at most 10 MB.');
    const metadata=await sharp(Buffer.from(await file.arrayBuffer()),{limitInputPixels:40000000}).metadata();
    if(!['jpeg','png','webp'].includes(metadata.format||''))throw new Error('Upload a genuine JPG, PNG or WEBP screenshot.');
    proof=await uploadOpsProof({companyId:company,field:'erp_proof',file,label:'ERP no-cash screenshot',section:'cod-exceptions',submissionId:id,imagesOnly:true});
   }
   if(!proof)throw new Error('Upload the ERP screenshot showing no cash.');
  }
  const subject=kind==='Banker Not Reported'?String(form.get('email_subject')||'').trim():null;
  const sender=kind==='Banker Not Reported'?emailList(String(form.get('sender_email')||'')):[];
  const stakeholders=kind==='Banker Not Reported'?emailList(String(form.get('stakeholder_emails')||'')):[];
  const pocs=kind==='Banker Not Reported'?emailList(String(form.get('client_poc_emails')||'')):[];
  const sent=String(form.get('email_sent_at')||'');
  let sentAt:string|null=null;
  if(kind==='Banker Not Reported'){
   if(!subject||subject.length<3||subject.length>250||/[\r\n]/.test(subject))throw new Error('Enter the exact email subject (3–250 characters).');
   if(sender.length!==1||!sender[0].endsWith('@dropxlogistics.com'))throw new Error('Enter the DropX address that sent this email.');
   if(form.get('sent_confirmed')!=='yes')throw new Error('Confirm the email was sent to the stakeholders and client COD POC, with Control Tower in CC.');
   const timestamp=new Date(sent+'+05:30');
   if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sent)||!Number.isFinite(timestamp.getTime())||timestamp.getTime()>Date.now()||sent.slice(0,10)!==date)throw new Error('Enter the actual sent time in IST on the selected report date.');
   sentAt=timestamp.toISOString();
  }
  const row={id,company_id:company,location_id:location,report_date:date,kind,reason,proof,email_subject:subject,sender_email:sender[0]||null,stakeholder_emails:stakeholders,client_poc_emails:pocs,email_cc:kind==='Banker Not Reported'?[CONTROL_TOWER_CC]:[],email_sent_at:sentAt,email_check_status:kind==='Banker Not Reported'?'Confirmation pending':'Not applicable',email_check_reason:null,email_message_id:null,email_checked_at:null,updated_by:auth.userId,updater_name:auth.fullName||auth.email||'Station user',updated_at:new Date().toISOString(),version:(prior?.version||0)+1};
  const saved=prior?await supabaseAdmin.from('cod_daily_exceptions').update(row).eq('company_id',company).eq('id',id).eq('version',prior.version).select('id'):await supabaseAdmin.from('cod_daily_exceptions').insert({...row,created_by:auth.userId}).select('id');
  if(saved.error)throw new Error(saved.error.code==='23505'?'An update already exists for this station/date. Reload and use Amend update.':saved.error.message);
  if(!saved.data?.length)throw new Error('This update changed. Reload before editing.');
  for(const path of ['/cod/submission','/cod/pending','/ops-pulse/cod/submission','/ops-pulse/cod/pending'])revalidatePath(path);
  return{ok:true,notice:kind==='No Cash'?'No Cash recorded with ERP proof.':'Banker Not Reported recorded. The existing email will be checked in the Control Tower mailbox; no new email was sent.'};
 }catch(error){return{ok:false,error:error instanceof Error?error.message:'Unable to record update.'};}
}
