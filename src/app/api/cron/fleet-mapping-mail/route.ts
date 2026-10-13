import {supabaseAdmin} from '@/lib/supabase-admin';
import {mappingMailClock,mappingMailDue,validateMappingMailConfig} from '@/lib/fleet/mapping-mail';
import {dispatchMappingMail} from '@/lib/fleet/mapping-mail-server';
export const dynamic='force-dynamic';export const maxDuration=60;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET?.trim();if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`)return Response.json({error:'Unauthorized'},{status:401});
 if(!supabaseAdmin)return Response.json({error:'Database unavailable'},{status:503});
 const settings=await supabaseAdmin.from('fleet_mapping_mail_settings').select('company_id,config');if(settings.error)return Response.json({error:'Settings unavailable'},{status:503});
 const now=mappingMailClock(),results=[];const deadline=Date.now()+45000;
 for(const s of settings.data||[]){if(Date.now()>=deadline)break;try{const c=validateMappingMailConfig(s.config);for(const slot of mappingMailDue(c,now.date,now.time))results.push(await dispatchMappingMail(s.company_id,slot,deadline));}catch(e){results.push({error:e instanceof Error?e.message:'Delivery failed'});}}
 const failed=results.some((r:any)=>r.error||r.results?.some((l:any)=>['failed','uncertain','sending'].includes(l.status)));
 return Response.json({date:now.date,results},{status:failed?500:200});
}
