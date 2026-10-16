import {createHash} from 'node:crypto';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {parsePaytap,validateMapping,verifyPaytap} from '@/lib/fleet/paytap';
import {fleetAuditContext} from '@/lib/fleet/audit-context';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:{endpointId:string}}){
 if(!supabaseAdmin)return Response.json({error:'Receiver unavailable'},{status:503});
 if(!/^[0-9a-f-]{36}$/i.test(params.endpointId))return new Response(null,{status:404});
 const connection=await supabaseAdmin.rpc('fleet_paytap_secret',{p_endpoint:params.endpointId});
 if(connection.error)return Response.json({error:'Receiver unavailable'},{status:503});
 const c=connection.data?.[0];if(!c)return new Response(null,{status:404});
 // Bound streamed bodies even when Content-Length is omitted. Never log secrets or payment bodies.
 const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400});
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return new Response(null,{status:413});}chunks.push(value);}
 const raw=Buffer.concat(chunks);
 if(!verifyPaytap(raw,request.headers.get('x-paytap-timestamp'),request.headers.get('x-paytap-signature'),c.signing_secret))return Response.json({error:'Invalid signature or expired timestamp'},{status:401});
 const event=request.headers.get('x-paytap-event-id');if(!event||event.length>200||/[\x00-\x1f]/.test(event))return Response.json({error:'Event ID required'},{status:400});
 let body;try{body=JSON.parse(raw.toString('utf8'));}catch{return new Response(null,{status:400});}
 if(!body||typeof body!=='object'||Array.isArray(body)||body.eventId!=null&&body.eventId!==event)return Response.json({error:'Invalid event envelope'},{status:400});
 try{
  const parsed=parsePaytap(body,validateMapping(c.mapping));
  const result=await fleetAuditContext.run({actorId:null,actorLabel:'PayTap signed webhook',viewerId:null,requestId:event,action:'paytap_ingest',route:new URL(request.url).pathname,companyId:c.company_id},()=>supabaseAdmin!.rpc('fleet_paytap_ingest',{p_company:c.company_id,p_event:event,p_hash:createHash('sha256').update(raw).digest('hex'),p_payload:body,p_state:parsed.state,p_reason:parsed.reason,p_fuel:parsed.fuel??null}));
  if(result.error)return Response.json({error:result.error.message.includes('EVENT_ID_CONFLICT')?'Event ID conflict':'Unable to persist event; retry delivery'},{status:result.error.message.includes('EVENT_ID_CONFLICT')?409:503});
  return Response.json({received:true,status:result.data});
 }catch{return Response.json({error:'Receiver configuration needs attention'},{status:503});}
}
