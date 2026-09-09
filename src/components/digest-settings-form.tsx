type Control={state:string;paused_until:string|null;subject_template:string|null;config:Record<string,unknown>};
type Receipt={id:string;recipient_email:string;report_date:string;status:string;error:string|null;completed_at:string|null};
export function DigestSettingsForm({control,action,canEdit,receipts}:{control:Control;action:(form:FormData)=>Promise<void>;canEdit:boolean;receipts:Receipt[]}){
 const paused=control.paused_until?new Date(Date.parse(control.paused_until)+19800000).toISOString().slice(0,16):'';
 return <>
 <form action={action} className="panel" style={{padding:24,marginTop:20}}>
 <h2>Daily email delivery</h2><p>Runs on the portal server. No laptop, browser or signed-in session is required. Previous-day data; one separate email thread per recipient per month.</p>
 <fieldset disabled={!canEdit} style={{border:0,padding:0,display:'grid',gap:18,gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))'}}>
 <label>Delivery status<select name="state" defaultValue={control.state}><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="disabled">Disabled</option></select></label>
 <label>Send every day at · IST<input name="schedule_time" type="time" required defaultValue={String(control.config.schedule_time||'08:00')}/></label>
 <label>Resume after pause · IST (optional)<input name="paused_until" type="datetime-local" defaultValue={paused}/></label>
 <label style={{gridColumn:'1 / -1'}}>Monthly subject<input name="subject" required maxLength={250} defaultValue={control.subject_template||''}/><small>Keep {'{{month}}'} and {'{{year}}'} in the subject. Replies retain the first subject used that month.</small></label>
 <label style={{gridColumn:'1 / -1'}}>Manager reminder<textarea name="reminder" rows={3} maxLength={1000} defaultValue={String(control.config.manager_reminder||'')}/></label>
 {(['included_models','recipient_role_codes','location_role_codes'] as const).filter(key=>Array.isArray(control.config[key])).map(key=><label key={key}>{key==='included_models'?'Included operation model codes':key==='recipient_role_codes'?'Recipient designation codes':'Location mailbox team designation codes'}<input name={key} required defaultValue={(control.config[key] as string[]).join(', ')}/><small>Comma-separated master codes. Personal manager emails always retain their authorized reporting / location scope.</small></label>)}
 <label><input type="checkbox" name="send_zero_cases" defaultChecked={control.config.send_zero_cases===true}/> Also send when there are no pending people / locations</label>
 <button className="button primary" type="submit">Save notification settings</button>
 </fieldset>
 <p><small>{control.config.delivery_ready===true?'Server delivery is ready. Changes apply to the next eligible run.':'Delivery is not activated until production verification is complete.'} Pausing or disabling stops unsent emails; accepted emails are never resent automatically.</small></p>
 </form>
 <section className="panel" style={{padding:24,marginTop:20}}><h2>Recent deliveries</h2><p>“Accepted” means the mail server accepted the message; it does not confirm it was read. A sending or uncertain result is held for verification, never blindly retried.</p>
 <div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>Report day</th><th>Recipient</th><th>Status</th><th>Details</th></tr></thead><tbody>{receipts.map(r=><tr key={r.id}><td>{r.report_date}</td><td>{r.recipient_email}</td><td>{r.status}</td><td>{r.error||'—'}</td></tr>)}</tbody></table></div>{!receipts.length?<p>No scheduled deliveries yet.</p>:null}</section>
 </>;
}
