import {AppShell} from '@/components/app-shell';
import {PageHead} from '@/components/page-head';
import {DigestSettingsForm} from '@/components/digest-settings-form';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {saveDigestSettings} from './actions';
export const dynamic='force-dynamic';
export default async function NotificationSettings({searchParams}:{searchParams?:{error?:string;saved?:string}}){
 const auth=await requirePagePermission('ops_notification_settings','access');const company=requireCompanyId(auth);const db=digestDatabase();
 const [control,history]=await Promise.all([
 db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').single(),
 db.from('portal_digest_deliveries').select('id,recipient_email,report_date,status,error,completed_at').eq('company_id',company).eq('portal','ops').order('report_date',{ascending:false}).order('started_at',{ascending:false}).limit(60)]);
 if(control.error||history.error)throw new Error('Notification settings are temporarily unavailable.');
 return <AppShell active="Notifications" pageCode="ops_notification_settings"><PageHead title="Notifications" eyebrow="Ops Pulse settings" subtitle="Daily performance review status · server-scheduled, individually scoped emails."/>
 {searchParams?.error?<p role="alert">{searchParams.error}</p>:searchParams?.saved?<p role="status">Notification settings saved.</p>:null}
 <section className="panel" style={{padding:24}}><h2>Daily performance review status</h2><p>Each recipient sees only their mapped locations. Pending locations first, with pending reviewers and review layers; completed locations follow. Proxy reviews identify who reviewed and on whose behalf.</p><p>Included operation models: {String((control.data.config.included_models||[]).join(', '))}. Other models are excluded from this mail.</p></section>
 <DigestSettingsForm control={control.data} action={saveDigestSettings} canEdit={hasPermission(auth,'ops_notification_settings','edit')} receipts={history.data||[]}/></AppShell>;
}
