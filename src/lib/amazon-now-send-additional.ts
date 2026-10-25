import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAmazonNowDigest } from './amazon-now-digest';
import { deliverPortalDigestQueue, digestEnabled, type DigestControl, type DigestDelivery } from './portal-digest-delivery';

/** Append only newly subscribed recipients to an existing morning run.
 * Unique daily receipts reserve the send before SMTP, including concurrent clicks.
 * Sending/uncertain/accepted receipts are never retried through this action.
 */
export async function sendNowAdditionalRecipients(db: SupabaseClient, company: string) {
 const event = 'now_activity_digest';
 const date = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata'}).format(new Date());
 const [saved, run] = await Promise.all([
  db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key',event).single(),
  db.from('portal_digest_runs').select('id').eq('company_id',company).eq('portal','ops').eq('event_key',event).eq('report_date',date).maybeSingle()
 ]);
 if (saved.error || run.error) throw Error('Handover schedule or delivery history is unavailable.');
 const control = saved.data as DigestControl;
 if (!digestEnabled(control)) throw Error('Enable the handover email schedule first.');
 if (!run.data) throw Error('Today’s scheduled handover has not run yet. Added recipients will receive it at the scheduled time.');
 const emails = Array.isArray(control.config.additional_recipient_emails)
  ? [...new Set(control.config.additional_recipient_emails.map(String).map(s=>s.trim().toLowerCase()).filter(Boolean))] : [];
 if (!emails.length || emails.length > 20) throw Error('Save between 1 and 20 additional recipients first.');
 const batch = await buildAmazonNowDigest(db,control,date);
 const messages = batch.messages.filter(m=>emails.includes(m.email));
 if (new Set(messages.map(m=>m.email)).size !== emails.length) throw Error('An added recipient no longer has eligible Amazon Now access. Check recipient settings.');
 const rows = messages.map(m=>({run_id:run.data!.id,company_id:company,portal:'ops',event_key:event,report_date:date,
  recipient_email:m.email,recipient_name:m.name,subject:m.subject,html:m.html,body:m.text,
  scope_summary:{...m.scope,manual_snapshot_at:batch.checkedAt},status:'sending',started_at:new Date().toISOString()}));
 // ON CONFLICT DO NOTHING also protects accepted recipients from accidental resends.
 const reserved = await db.from('portal_digest_deliveries').upsert(rows,{
  onConflict:'company_id,portal,event_key,report_date,recipient_email',ignoreDuplicates:true
 }).select('id,company_id,event_key,report_date,recipient_email,subject,html,body');
 if (reserved.error) throw Error('Could not reserve email delivery. No new mail was sent.');
 const deliveries = (reserved.data || []) as DigestDelivery[];
 const summary = await deliverPortalDigestQueue(db,'ops',{queued:deliveries.length,accepted:0,uncertain:0,skipped:0,errors:[]},'portal_claim_digest',deliveries);
 return {...summary,existing:emails.length-deliveries.length};
}
