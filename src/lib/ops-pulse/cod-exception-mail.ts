import 'server-only';
import {GoogleLocationMailClient} from '@/lib/google-workspace-client';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {CONTROL_TOWER_CC} from './cod-proof-policy';
import {matchesCodEmail} from './cod-mail-evidence';
import type {CodException} from './cod-exceptions';
export async function checkCodExceptionEmails(){
 if(!supabaseAdmin)throw new Error('Database unavailable.');
 const cutoff=new Date(Date.now()-15*60000).toISOString(),since=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
 const result=await supabaseAdmin.from('cod_daily_exceptions').select('*').eq('kind','Banker Not Reported').neq('email_check_status','Email confirmed').gte('updated_at',since).or(`email_checked_at.is.null,email_checked_at.lt.${cutoff}`).order('email_checked_at',{nullsFirst:true}).limit(2);
 if(result.error)throw new Error(result.error.message);
 let checked=0,confirmed=0;
 for(const row of (result.data||[]) as CodException[]){
  let status='Email not found',reason='No matching email was found with the recorded sender, subject, recipients and Control Tower CC.',messageId:string|null=null;
  try{
   const setting=await supabaseAdmin.from('google_workspace_settings').select('primary_domain').eq('company_id',row.company_id).maybeSingle();
   if(setting.error||setting.data?.primary_domain!=='dropxlogistics.com')throw new Error('Control Tower mailbox is not configured for this company.');
   const client=new GoogleLocationMailClient(CONTROL_TOWER_CC,AbortSignal.timeout(60000));
   const start=Math.floor(Date.parse(row.email_sent_at!)/1000)-3600,end=start+7201;
   const query=`from:${row.sender_email} after:${start} before:${end}`;
   let pageToken:string|undefined;
   for(let page=0;page<2;page++){
    const listed=await client.listMessages({query,maxResults:20,pageToken});
    for(const candidate of listed.messages||[]){
     const message=await client.getMessageMetadata(candidate.id);
     if(matchesCodEmail(message,row)){messageId=candidate.id;break;}
    }
    pageToken=listed.nextPageToken;if(messageId||!pageToken)break;
   }
   if(messageId){status='Email confirmed';reason='Matching email found in the Control Tower mailbox with all recorded recipients and mandatory CC.';confirmed++;}
   else if(pageToken){status='Email check unavailable';reason='Mailbox results were incomplete. Confirmation will be retried.';}
  }catch(error){console.error('COD mailbox confirmation unavailable',row.id,error instanceof Error?error.message:'Unknown error');status='Email check unavailable';reason='Control Tower mailbox confirmation is unavailable. The recorded email has not yet been independently confirmed.';}
  let save=supabaseAdmin.from('cod_daily_exceptions').update({email_check_status:status,email_check_reason:reason,email_message_id:messageId,email_checked_at:new Date().toISOString()}).eq('company_id',row.company_id).eq('id',row.id).eq('version',row.version).eq('email_check_status',row.email_check_status);
  save=row.email_checked_at?save.eq('email_checked_at',row.email_checked_at):save.is('email_checked_at',null);
  const saved=await save;
  if(saved.error)throw new Error(saved.error.message);checked++;
 }
 return{checked,confirmed};
}
