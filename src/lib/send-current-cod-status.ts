import 'server-only';
import {buildCodPendingDigest} from '@/lib/cod-pending-digest';
import {deliverPortalDigestQueue,digestDatabase} from '@/lib/portal-digest-delivery';

export async function sendCurrentCodStatus(companyId:string){
 const db=digestDatabase();
 const date=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
 const reportDate=`${date.year}-${date.month}-${date.day}`;
 const control=await db.from('portal_notification_controls').select('*').eq('company_id',companyId).eq('portal','ops').eq('event_key','cod_pending_evening').single();
 if(control.error)throw new Error(control.error.message);
 if(control.data.state!=='enabled'||control.data.config?.delivery_ready!==true)throw new Error('COD delivery is not enabled.');
 const batch=await buildCodPendingDigest(db,control.data,reportDate);
 if(!batch.messages.length)throw new Error('No eligible COD recipients were found.');
 if(new Set(batch.messages.map(message=>message.email)).size!==batch.messages.length)throw new Error('Conflicting recipient scopes; no email queued.');
 const queued=await db.rpc('portal_enqueue_digest',{p_company_id:companyId,p_portal:'ops',p_event_key:'cod_pending_current',p_report_date:reportDate,p_snapshot_at:batch.checkedAt,p_messages:batch.messages});
 if(queued.error)throw new Error(queued.error.message);
 const result=await deliverPortalDigestQueue(db,'ops',{queued:queued.data?batch.messages.length:0,accepted:0,uncertain:0,skipped:0,errors:[]});
 if(result.errors.length||result.uncertain)throw new Error(`${result.accepted} accepted; ${result.uncertain} require delivery verification; ${result.skipped} skipped.`);
 if(!queued.data&&!result.accepted&&!result.skipped)throw new Error('Today’s current-status reply has already been sent.');
 return {reportDate,...result};
}
