import 'server-only';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getAuthorization } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { fleetAuditContext } from './audit-context';
export function withFleetSystemLog<T extends Request>(handler:(request:T)=>Promise<Response | undefined>) {
 return async(request:T)=>{
  const auth=await getAuthorization();
  let body:Record<string,unknown>={};
  if(request.headers.get('content-type')?.includes('application/json')){const parsed=await request.clone().json().catch(()=>null);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed;}
  const action=String(body.action??request.method.toLowerCase()).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);
  const context={actorId:auth?.viewerUserId??auth?.userId??null,actorLabel:auth?.isPreview?`Administrator preview (${auth.fullName||'user'})`:auth?.fullName||auth?.email||'Unsigned request',viewerId:auth?.viewerUserId??null,requestId:randomUUID(),action,route:new URL(request.url).pathname,companyId:auth?.companyId??null};
  return fleetAuditContext.run(context,async()=>{
   let response:Response;
   try{response=auth?.readOnly?NextResponse.json({error:'User preview is read-only. Exit preview before making changes.'},{status:403}):(await handler(request))??NextResponse.json({error:"The request could not be completed."},{status:500});}catch(error){await record('failed',500);throw error;}
   await record(response.status===401||response.status===403?'denied':response.ok?'success':'failed',response.status);
   return response;
  });
  async function record(outcome:string,httpStatus:number){
   if(!supabaseAdmin)return;
   const result=await supabaseAdmin.from('fleet_system_logs').insert({company_id:context.companyId,request_id:context.requestId,event_kind:'request',entity:'request',action,actor_user_id:context.actorId,actor_label:context.actorLabel,viewer_user_id:context.viewerId,outcome,route:context.route,http_status:httpStatus,subject:String(body.vehicle_no??body.requestId??body.auditId??body.vehicleId??body.id??'').slice(0,120)});
   if(result.error)console.error('Fleet request audit unavailable',result.error.code);
  }
 };
}
