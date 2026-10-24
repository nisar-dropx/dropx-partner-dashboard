import { digestDatabase } from "@/lib/portal-digest-delivery";
import { defaultNowControl, loadNowMailScope, nowDigestEvents } from "@/lib/amazon-now-digest";
import { saveAmazonNowDigestSettings } from "@/app/settings/notifications/actions";
import { DigestSettingsForm } from "./digest-settings-form";
export async function AmazonNowNotificationSettings({ companyId, canEdit, domain }: { companyId: string; canEdit: boolean; domain: string }) {
 const db = digestDatabase();
 const controls = await db.from("portal_notification_controls").select("*").eq("company_id",companyId).eq("portal","ops").in("event_key",[...nowDigestEvents]);
 if (controls.error) return <p role="alert">Amazon Now schedules could not be loaded.</p>;
 const sections = await Promise.all(nowDigestEvents.map(async event => {
  const control = controls.data?.find(c=>c.event_key===event) || defaultNowControl(companyId,event,domain);
  const [scope,receipts] = await Promise.all([
   loadNowMailScope(db,control).catch((e:Error)=>({stations:[],recipients:[],error:e.message})),
   db.from("portal_digest_deliveries").select("id,recipient_email,report_date,status,error,completed_at").eq("company_id",companyId).eq("portal","ops").eq("event_key",event).order("report_date",{ascending:false}).limit(40)
  ]);
  return <details key={event} className="panel" style={{padding:16,marginTop:12}}><summary><strong>{event==="now_review_digest"?"Store review · D−2":"Activities & handover · previous day"}</strong> · {String(control.config.schedule_time)} IST · {control.state}</summary>
   <p>Only Amazon Now stores and configured operations roles. Accounts, departments and location access are rechecked before delivery. No individual’s name is hardcoded.</p>
   <a className="button secondary" href={`/api/ops-pulse/amazon-now-digest-preview?event=${event}`} target="_blank" rel="noreferrer">Preview current email</a>
   {'error' in scope?<p role="alert">{scope.error}</p>:<details><summary>{scope.recipients.length} recipients · {scope.stations.length} stores</summary><table><thead><tr><th>Recipient</th><th>Stores</th></tr></thead><tbody>{scope.recipients.map(r=><tr key={r.email}><td>{r.name}<br/><small>{r.email}</small></td><td>{scope.stations.filter(s=>r.stationIds.includes(s.id)).map(s=>s.station_code).join(", ")}</td></tr>)}</tbody></table></details>}
   <DigestSettingsForm control={control} canEdit={canEdit} action={saveAmazonNowDigestSettings.bind(null,event)} receipts={receipts.data || []}/>
  </details>;
 }));
 return <section id="amazon-now"><h2>Amazon Now · daily store summaries</h2><p>Two compact store tables. Each recipient gets one monthly thread for reviews and one for activities. Store accounts receive their own stores; managers receive their assigned stores.</p>{sections}</section>;
}
