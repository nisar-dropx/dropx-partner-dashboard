import {digestDatabase} from '@/lib/portal-digest-delivery';
import {LOSS_REMINDER_STAGES,LOSS_REMINDER_EVENTS,LOSS_REMINDER_COPY,lossReminderEdition} from '@/lib/loss-reminder-policy';
import {saveLossStageReminderSettings} from '@/app/settings/notifications/actions';
export async function LossReminderSettings({companyId,canEdit}:{companyId:string;canEdit:boolean}){
 const db=digestDatabase();
 const [controls,history]=await Promise.all([
  db.from('portal_notification_controls').select('event_key,state,config').eq('company_id',companyId).eq('portal','ops').in('event_key',LOSS_REMINDER_EVENTS),
  db.from('portal_digest_deliveries').select('id,event_key,recipient_email,report_date,status,error').eq('company_id',companyId).eq('portal','ops').in('event_key',LOSS_REMINDER_EVENTS).order('report_date',{ascending:false}).order('started_at',{ascending:false}).limit(50),
 ]);
 if(controls.error||history.error)return <section className="panel" style={{padding:16}}>Loss reminder settings could not be loaded.</section>;
 if(!controls.data.length)return null;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
 const todayOverride=controls.data.find(c=>c.event_key.endsWith('_afternoon')&&c.config?.one_time_schedule?.date===today)?.config?.one_time_schedule;
 return <section id="loss-stage-reminders" className="panel" style={{padding:16,marginTop:16}}><h2>NL / SLP · Action reminders</h2><p style={{fontSize:13}}>11 a.m. and 4 p.m. IST · Station summary + shipment Excel · One thread per stage and monthly cycle. Nothing pending, no email.</p>{todayOverride?<p style={{fontSize:13,color:'#b54716'}}>Today only · afternoon reminder at {lossReminderEdition('loss_reminder_recovery_afternoon',todayOverride.time)} IST.</p>:null}<div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>Stage</th><th>Days</th><th>Status</th><th>Preview</th></tr></thead><tbody>{LOSS_REMINDER_STAGES.map(stage=>{
 const pair=controls.data.filter(c=>c.event_key.startsWith(`loss_reminder_${stage}_`));
 return <tr key={stage}><td>{LOSS_REMINDER_COPY[stage].title}</td><td>{stage==='recovery'?'20th–next 5th':stage==='dispute'?'7th–11th':'11th–20th'}</td><td><form action={saveLossStageReminderSettings} style={{display:'flex',gap:6}}><input type="hidden" name="stage" value={stage}/><select className="field" name="state" aria-label={`${stage} delivery status`} disabled={!canEdit} defaultValue={pair.every(c=>c.state==='enabled')?'enabled':'disabled'}><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select><button className="button secondary" disabled={!canEdit}>Save</button></form></td><td><a href={`/api/ops-pulse/loss-reminder-preview?stage=${stage}`} target="_blank" rel="noreferrer">View mail ↗</a></td></tr>;
 })}</tbody></table></div><details style={{marginTop:12}}><summary>Recent deliveries</summary><div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>Day</th><th>Stage / edition</th><th>Recipient</th><th>Status</th></tr></thead><tbody>{history.data.map(r=><tr key={r.id}><td>{r.report_date}</td><td>{r.event_key.replace('loss_reminder_','').replace('_',' · ')}</td><td>{r.recipient_email}</td><td title={r.error||undefined}>{r.status}</td></tr>)}</tbody></table>{!history.data.length?<p>No scheduled deliveries yet.</p>:null}</div></details></section>;
}
