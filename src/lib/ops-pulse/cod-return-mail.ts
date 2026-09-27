import 'server-only';
import nodemailer from 'nodemailer';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {loadPeopleOperationalHierarchy,loadOpsScopedManagerReviewChain} from '@/lib/people-operational-hierarchy';
import {returnMail,returnMessageId,returnThreadSubject} from './cod-return-policy';
const address=(v:unknown)=>typeof v==='string'&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@dropxlogistics\.com$/i.test(v.trim())?v.trim().toLowerCase():null;
export async function codReturnRecipients(company:string,location:string){
 if(!supabaseAdmin)throw new Error('Database unavailable');
 const station=await supabaseAdmin.from('stations').select('station_email,station_code').eq('company_id',company).eq('id',location).eq('is_active',true).single();
 if(station.error)throw new Error('Active station could not be loaded');
 const to=address(station.data.station_email);if(!to)throw new Error('Station email is missing or invalid');
 const hierarchy=await loadPeopleOperationalHierarchy(company,[location]);if(hierarchy.error)throw new Error('Cluster-manager hierarchy unavailable');
 let managers=hierarchy.byLocation.get(location)?.clusterManagers||[];
 if(!managers.length){const fallback=await loadOpsScopedManagerReviewChain(company,location);if(fallback.error)throw new Error('Cluster-manager hierarchy unavailable');managers=fallback.chain.filter(p=>/cluster|(^|_)cm($|_)/i.test(p.designationCode||p.role));}
 if(!managers.length)throw new Error('Assign a cluster manager in People before the return email can be sent');
 const links=await supabaseAdmin.from('hr_user_person_links').select('user_id,person_id').eq('company_id',company).eq('status','active').in('person_id',managers.map(p=>p.personId));
 if(links.error||!links.data?.length)throw new Error('Cluster-manager account link is missing');
 const profiles=await supabaseAdmin.from('profiles').select('id,email').eq('company_id',company).eq('is_active',true).in('id',links.data.map(p=>p.user_id));
 if(profiles.error)throw new Error('Cluster-manager email could not be loaded');
 const cc=[...new Set((profiles.data||[]).map(p=>address(p.email)).filter((v):v is string=>Boolean(v)))].filter(v=>v!==to);
 if(!cc.length)throw new Error('Active cluster-manager email is missing');
 return {to,cc,station:station.data.station_code as string};
}
export async function deliverCodReturns(){
 if(!supabaseAdmin)throw new Error('Database unavailable');
 const db=supabaseAdmin;let sent=0,held=0;
 for(let i=0;i<3;i++){
  const claim=await db.rpc('claim_cod_return_mail');if(claim.error)throw new Error(claim.error.message);const job=claim.data?.[0];if(!job)break;
  let sending=false;let transport:ReturnType<typeof nodemailer.createTransport>|undefined;
  try{
   const [recipients,smtpResult,threadResult]=await Promise.all([
    codReturnRecipients(job.company_id,job.location_id),
    db.from('email_notification_settings').select('is_enabled,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,smtp_from,from_name').eq('company_id',job.company_id).eq('id',true).single(),
    db.from('cod_return_threads').select('*').eq('company_id',job.company_id).eq('location_id',job.location_id).maybeSingle()
   ]);
   if(smtpResult.error||threadResult.error)throw new Error('Return email configuration could not be loaded');
   const smtp=smtpResult.data,thread=threadResult.data;
   if(!smtp.is_enabled||!smtp.smtp_host||!smtp.smtp_pass||!smtp.smtp_from)throw new Error('Company email delivery is not configured or enabled');
   const messageId=returnMessageId(job.id),root=thread?.root_message_id||messageId,subject=thread?.subject||returnThreadSubject(recipients.station),all=[recipients.to,...recipients.cc];
   const mail=returnMail({station:recipients.station,date:job.deposit_date,reference:job.reference||'No reference',reason:job.reason,actor:job.actor_name,submissionId:job.submission_id,locationId:job.location_id});
   const prepared=await db.from('cod_slip_returns').update({message_id:messageId,recipients:all}).eq('id',job.id).eq('mail_status','sending');if(prepared.error)throw new Error('Could not save return email delivery record');
   const port=Number(smtp.smtp_port);
   transport=nodemailer.createTransport({host:smtp.smtp_host,port,secure:port===465||(Boolean(smtp.smtp_secure)&&port!==587),auth:{user:smtp.smtp_user,pass:smtp.smtp_pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:25000,disableFileAccess:true,disableUrlAccess:true});
   sending=true;
   const receipt=await transport.sendMail({from:'"'+String(smtp.from_name||'DropX OpsPulse').replace(/["\r\n]/g,'')+'" <'+smtp.smtp_from+'>',to:recipients.to,cc:recipients.cc,subject,...mail,messageId,inReplyTo:thread?.last_message_id,references:thread?[...new Set([thread.root_message_id,thread.last_message_id])]:undefined});
   if(!all.every(email=>receipt.accepted?.includes(email)))throw new Error('Delivery to every recipient needs verification');
   const finish=await db.rpc('finish_cod_return_mail',{p_id:job.id,p_subject:subject,p_root:root,p_message:messageId,p_recipients:all});if(finish.error)throw new Error('Mail accepted; receipt needs verification');sent++;
  }catch(error){
   held++;const reason=error instanceof Error?error.message:'Return email unavailable';
   const saved=await db.from('cod_slip_returns').update({mail_status:sending?'uncertain':'blocked',mail_error:reason.slice(0,300)}).eq('id',job.id).eq('mail_status','sending');
   if(saved.error)console.error('COD return receipt persistence failed',job.id);else console.error('COD return email held',job.id,reason);
  }finally{transport?.close();}
 }
 return {sent,held};
}
