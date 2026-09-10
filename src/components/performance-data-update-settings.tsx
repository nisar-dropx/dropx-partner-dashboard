type Control={state:string;paused_until:string|null;subject_template:string|null;body_template:string|null;config:Record<string,unknown>};
type Receipt={id:string;recipient_email:string;report_date:string;status:string;error:string|null};
export function PerformanceDataUpdateSettings({control,action,canEdit,receipts}:{control:Control;action:(form:FormData)=>Promise<void>;canEdit:boolean;receipts:Receipt[]}) {
 const paused=control.paused_until?new Date(Date.parse(control.paused_until)+19800000).toISOString().slice(0,16):'';
 return <section id="performance-data-updated" className="panel" style={{padding:24,marginBottom:20}}>
  <h2>Performance data updated</h2>
  <p>One compact notice when completed performance data becomes available. Relevant Ops managers and location mailboxes only; one notice per recipient per performance day, with daily replies in a monthly thread.</p>
  <form action={action}><fieldset disabled={!canEdit} style={{border:0,padding:0,display:'grid',gap:16,gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))'}}>
   <label>Delivery status<select className="field" name="state" defaultValue={control.state}><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="disabled">Disabled</option></select></label>
   <label>Resume after pause · IST (optional)<input className="field" name="paused_until" type="datetime-local" defaultValue={paused}/></label>
   <label style={{gridColumn:'1 / -1'}}>Monthly subject<input className="field" name="subject" required maxLength={250} defaultValue={control.subject_template||''}/><small>Keep {'{{month}}'} and {'{{year}}'}. The subject stays the same for replies in that month.</small></label>
   <label style={{gridColumn:'1 / -1'}}>Update message<textarea className="field" name="body" required rows={3} maxLength={1000} defaultValue={control.body_template||''}/><small>{'{{date}}'} is replaced by the actual performance date. A review button and your updated location list are included automatically.</small></label>
   {(['included_models','recipient_role_codes'] as const).map(key=><label key={key}>{key==='included_models'?'Included operation model codes':'Recipient Ops role codes'}<input className="field" name={key} required defaultValue={((control.config[key]||[]) as string[]).join(', ')}/><small>Comma-separated codes. Membership and location access are always checked.</small></label>)}
   <div style={{gridColumn:'1 / -1'}}><button className="button primary" type="submit">Save data update notification</button></div>
  </fieldset></form>
  <p><small>Checked by the portal server every minute; no laptop required. Failed, incomplete and duplicate-only imports do not trigger a notice. No historical import backfill is sent on activation. SMTP-accepted messages are not automatically resent.</small></p>
  <details><summary>Recent data update deliveries ({receipts.length})</summary><div className="table-wrap"><table><thead><tr><th>Performance day</th><th>Recipient</th><th>Status</th><th>Details</th></tr></thead><tbody>{receipts.map(r=><tr key={r.id}><td>{r.report_date}</td><td>{r.recipient_email}</td><td>{r.status}</td><td>{r.error||'—'}</td></tr>)}</tbody></table></div>{!receipts.length?<p>No data update notifications sent yet.</p>:null}</details>
 </section>;
}
