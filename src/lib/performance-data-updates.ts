import 'server-only';
import {digestDatabase,digestEnabled,deliverPortalDigestQueue,type DigestControl,type DeliverySummary} from './portal-digest-delivery';
import {buildPerformanceDataUpdateMessages} from './performance-data-update-template.mjs';

export async function processPerformanceDataUpdates() {
  const db=digestDatabase();
  const summary:DeliverySummary={queued:0,accepted:0,uncertain:0,skipped:0,errors:[]};
  const controls=await db.from('portal_notification_controls').select('*').eq('portal','ops').eq('event_key','performance_data_updated');
  if(controls.error)throw new Error(controls.error.message);
  for(const control of (controls.data||[]) as (DigestControl & {body_template:string|null})[]) {
    if(!digestEnabled(control))continue;
    const dates=await db.rpc('portal_ops_data_update_dates',{p_company_id:control.company_id});
    if(dates.error)throw new Error(dates.error.message);
    for(const {report_date:date} of dates.data||[]) {
      const recipients=await db.rpc('portal_ops_data_update_recipients',{p_company_id:control.company_id,p_report_date:date});
      if(recipients.error)throw new Error(recipients.error.message);
      const messages=buildPerformanceDataUpdateMessages(recipients.data||[],date,control);
      if(!messages.length)continue;
      const queued=await db.rpc('portal_enqueue_ops_data_update',{p_company_id:control.company_id,p_report_date:date,p_messages:messages});
      if(queued.error)throw new Error(queued.error.message);
      if(queued.data)summary.queued+=messages.length;
    }
  }
  return deliverPortalDigestQueue(db,'ops',summary,'portal_claim_ops_data_updates');
}
