import {digestDatabase} from "@/lib/portal-digest-delivery";
import {registrationEvents} from "@/lib/registration-pendency";
import {saveRegistrationDigestSettings} from "@/app/settings/notifications/actions";

export async function RegistrationNotificationSettings({companyId,canEdit}:{companyId:string;canEdit:boolean}){
 const db=digestDatabase();
 const [controls,history]=await Promise.all([
  db.from("portal_notification_controls").select("event_key,state,config").eq("company_id",companyId).eq("portal","ops").in("event_key",[...registrationEvents]).order("event_key",{ascending:false}),
  db.from("portal_digest_deliveries").select("id,recipient_email,report_date,event_key,status,error").eq("company_id",companyId).eq("portal","ops").in("event_key",[...registrationEvents]).order("created_at",{ascending:false}).limit(40)
 ]);
 if(controls.error||history.error)return <section className="panel" style={{padding:24}}><h2>Registration pendency</h2><p>Registration notification settings could not be loaded. Refresh to retry.</p></section>;
 return <section id="registration-pendency" className="panel" style={{padding:24,marginTop:20}}>
  <h2>Registration pendency · People + Workforce</h2>
  <p>Daily morning action list and afternoon follow-up, grouped by station/store for each current reporting manager. Fresh status and missing-field Excel attached. No email when there is no pendency.</p>
  <a className="button" href="/api/ops-pulse/registration-email-preview" target="_blank" rel="noreferrer">Preview and check manager routing (owner)</a>
  {controls.data?.map(control=><form key={control.event_key} action={saveRegistrationDigestSettings} style={{marginTop:18,display:"flex",gap:14,alignItems:"end",flexWrap:"wrap"}}>
   <input type="hidden" name="event" value={control.event_key}/>
   <label>{control.event_key.endsWith("_morning")?"Morning report":"Afternoon follow-up"}<select name="state" className="field" defaultValue={control.state} disabled={!canEdit}><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="disabled">Disabled</option></select></label>
   <label>Daily time · IST<input type="time" name="schedule_time" className="field" required defaultValue={control.config.schedule_time} disabled={!canEdit}/></label>
   <button type="submit" className="button primary" disabled={!canEdit}>Save schedule</button>
   <small>{control.config.delivery_ready?"Server delivery ready":"Pending production verification · no mail sent"}</small>
  </form>)}
  {!controls.data?.length?<p>Schedule has not been installed.</p>:null}
  <details style={{marginTop:20}}><summary>Recent registration email deliveries</summary><div style={{overflowX:"auto"}}><table style={{width:"100%",textAlign:"left"}}><thead><tr><th>Day</th><th>Slot</th><th>Manager</th><th>Status</th><th>Details</th></tr></thead><tbody>{history.data?.map(r=><tr key={r.id}><td>{r.report_date}</td><td>{r.event_key.endsWith("_morning")?"Morning":"Follow-up"}</td><td>{r.recipient_email}</td><td>{r.status}</td><td>{r.error||"—"}</td></tr>)}</tbody></table></div>{!history.data?.length?<p>No scheduled deliveries yet.</p>:null}</details>
 </section>;
}
