import {LossReminderSettings} from '@/components/loss-reminder-settings';
import {InsightNotificationSettings} from '@/components/insight-notification-settings';
import { AmazonNowNotificationSettings } from '@/components/amazon-now-notification-settings';
import {CodNotificationSettings} from '@/components/cod-notification-settings';
import {AppShell} from '@/components/app-shell';
import {PageHead} from '@/components/page-head';
import {DigestSettingsForm} from '@/components/digest-settings-form';
import {requirePagePermission,hasPermission,isCompanyOwner} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {saveAdHocDigestSettings,saveDigestSettings,saveLossRecoveryDigestSettings,savePerformanceDataUpdateSettings} from './actions';
import {PerformanceDataUpdateSettings} from '@/components/performance-data-update-settings';
import {RegistrationNotificationSettings} from '@/components/registration-notification-settings';
export const dynamic='force-dynamic';
export default async function NotificationSettings({searchParams}:{searchParams?:{error?:string;saved?:string}}){
 const auth=await requirePagePermission('ops_notification_settings','access');const company=requireCompanyId(auth);const db=digestDatabase();
 const canEdit=hasPermission(auth,'ops_notification_settings','edit');
 const [adhoc,adhocHistory]=await Promise.all([
 db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','adhoc_usage_digest').single(),
 db.from('portal_digest_deliveries').select('id,recipient_email,report_date,status,error,completed_at').eq('company_id',company).eq('portal','ops').eq('event_key','adhoc_usage_digest').order('report_date',{ascending:false}).limit(60)]);
 const [control,history,dataUpdate,updateHistory,lossDigest,lossHistory]=await Promise.all([
 db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').single(),
 db.from('portal_digest_deliveries').select('id,recipient_email,report_date,status,error,completed_at').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').order('report_date',{ascending:false}).order('started_at',{ascending:false}).limit(60),
 db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','performance_data_updated').single(),
 db.from('portal_digest_deliveries').select('id,recipient_email,report_date,status,error,completed_at').eq('company_id',company).eq('portal','ops').eq('event_key','performance_data_updated').order('report_date',{ascending:false}).order('started_at',{ascending:false}).limit(60),
 db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','loss_recovery_action_digest').maybeSingle(),
 db.from('portal_digest_deliveries').select('id,recipient_email,report_date,status,error,completed_at').eq('company_id',company).eq('portal','ops').like('event_key','loss_recovery_%').order('report_date',{ascending:false}).limit(60)]);
 if(control.error||history.error||dataUpdate.error||updateHistory.error)throw new Error('Notification settings are temporarily unavailable.');
 return <AppShell active="Notifications" pageCode="ops_notification_settings"><PageHead title="Notifications" eyebrow="Ops Pulse settings" subtitle="Performance updates and daily review status · portal-run, individually scoped emails."/>
 {searchParams?.error?<p role="alert">{searchParams.error}</p>:searchParams?.saved?<p role="status">Notification settings saved.</p>:null}
 <InsightNotificationSettings companyId={company} canEdit={canEdit && !auth.isPreview && !auth.readOnly}/>
 <AmazonNowNotificationSettings companyId={company} canEdit={canEdit && !auth.isPreview && !auth.readOnly} domain={String(control.data.config.email_domain || "")}/>
 <RegistrationNotificationSettings companyId={company} canEdit={canEdit} ownerUserId={isCompanyOwner(auth)&&!auth.isPreview&&!auth.readOnly?auth.userId:undefined} ownerEmail={auth.email}/>
 {adhoc.data?<section id="adhoc-report"><h2>Ad hoc costs · Morning report</h2><a className="button" href="/api/ops-pulse/adhoc-email-preview" target="_blank" rel="noreferrer">Preview / send sample to me</a><p>Van, Driver and DA · Previous day and MTD · Estimated vs actual Excel · Monthly replies.</p><DigestSettingsForm control={adhoc.data} action={saveAdHocDigestSettings} canEdit={canEdit} receipts={adhocHistory.data||[]}/></section>:null}
 <LossReminderSettings companyId={company} canEdit={canEdit && !auth.isPreview && !auth.readOnly}/>
 <CodNotificationSettings companyId={company} auth={auth}/>
 <PerformanceDataUpdateSettings control={dataUpdate.data} action={savePerformanceDataUpdateSettings} canEdit={canEdit} receipts={updateHistory.data||[]}/>
 <section className="panel" style={{padding:24}}><h2>Daily performance review status</h2><p>Each recipient sees only their mapped locations. Pending locations first, with pending reviewers and review layers; completed locations follow. Proxy reviews identify who reviewed and on whose behalf.</p><p>Included operation models: {String((control.data.config.included_models||[]).join(', '))}. Other models are excluded from this mail.</p></section>
 <DigestSettingsForm control={control.data} action={saveDigestSettings} canEdit={canEdit} receipts={history.data||[]}/>
 {lossDigest.data?<section id="loss-recovery-digest" className="panel" style={{padding:24,marginTop:20}}>
  <h2>Loss recovery · Legacy daily digest</h2>
  <p>Scoped NL/SLP open actions (station / cluster / SLP). Empty days send nothing. Cron is already registered; keep <b>disabled</b> until recipients are verified. Enabling requires <code>delivery_ready=true</code> in the control config after the dry-run day.</p>
  <p><a className="button secondary" href="/api/ops-pulse/loss-recovery-digest-preview" target="_blank" rel="noreferrer">Preview current report / send to me</a></p>
  <form action={saveLossRecoveryDigestSettings} className="form-grid" style={{marginTop:16,gap:18,gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,280px),1fr))'}}>
   <fieldset disabled={!canEdit} style={{border:0,padding:0,minWidth:0,display:'contents'}}>
    <label>Delivery status<select className="field" name="state" defaultValue={lossDigest.data.state}><option value="disabled">Disabled</option><option value="paused">Paused</option><option value="enabled">Enabled</option></select></label>
    <label>Send every day at · IST<input className="field" name="schedule_time" type="time" required defaultValue={String(lossDigest.data.config?.schedule_time||'09:00')}/></label>
    <label style={{gridColumn:'1 / -1'}}>Subject<input className="field" name="subject" required maxLength={250} defaultValue={lossDigest.data.subject_template||'DropX · Loss recovery actions · {{date}}'}/><small>Keep {'{{date}}'} in the subject.</small></label>
    <button className="button primary" type="submit">Save loss recovery digest</button>
   </fieldset>
  </form>
  <p><small>{lossDigest.data.config?.delivery_ready===true?'delivery_ready is set — you may enable after verifying recipients.':'delivery_ready is false — dry-run only; enable is blocked until verification.'}</small></p>
  <h3 style={{marginTop:20}}>Recent deliveries</h3>
  <div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>Report day</th><th>Recipient</th><th>Status</th><th>Details</th></tr></thead><tbody>{(lossHistory.data||[]).map(r=><tr key={r.id}><td>{r.report_date}</td><td>{r.recipient_email}</td><td>{r.status}</td><td>{r.error||'—'}</td></tr>)}</tbody></table></div>
  {!lossHistory.data?.length?<p>No scheduled deliveries yet (expected while disabled).</p>:null}
 </section>:null}
 </AppShell>;
}
