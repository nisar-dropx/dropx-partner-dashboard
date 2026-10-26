import {getAuthorization,hasPermission} from '@/lib/authorization';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {buildInsightDigest,defaultInsightControl,insightEvents,type InsightEvent} from '@/lib/ops-pulse/insight-digest';
import {loadCodLocations} from '@/lib/ops-pulse/cod';
import {resolveOperatingContext} from '@/lib/ops-pulse/operating-context';
export const dynamic='force-dynamic';
export const maxDuration=180;
export async function GET(request:Request){
 const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
 const auth=await getAuthorization();
 if(!auth?.companyId||!hasPermission(auth,'ops_notification_settings','access'))return Response.json({error:'Notification settings access required.'},{status:403,headers});
 const event=new URL(request.url).searchParams.get('event') as InsightEvent;
 if(!insightEvents.includes(event))return Response.json({error:'Choose an insight edition.'},{status:400,headers});
 try{
  const db=digestDatabase();const saved=await db.from('portal_notification_controls').select('*').eq('company_id',auth.companyId).eq('portal','ops').eq('event_key',event).maybeSingle();
  if(saved.error)throw Error('Settings unavailable.');
  const locations=await loadCodLocations(auth.companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if(locations.error)throw Error('Store scope unavailable.');
  const selected=resolveOperatingContext(locations.locations);
  if(selected.mode!=='amazon_now')throw Error('Select Dark Store mode before previewing.');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
  const batch=await buildInsightDigest(db,saved.data||defaultInsightControl(auth.companyId,event),date,{email:auth.email||'',stationIds:selected.selectedLocations.map(s=>s.id)});
  const message=batch.messages.find(m=>m.email===auth.email);
  if(!message)throw Error('Your account is not in the existing Dark Store report audience.');
  return new Response(message.html,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src https://ops.dropxlogistics.com; frame-ancestors 'self'"}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Preview unavailable.'},{status:503,headers});}
}
