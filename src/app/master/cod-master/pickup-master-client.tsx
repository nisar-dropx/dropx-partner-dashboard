'use client';
import { Fragment, useState } from 'react';
import { SearchableSelect } from '@/components/searchable-select';
import { SubmitButton } from '@/components/submit-button';
import { pickupDescriptions, pickupRules, type PickupRule } from '@/lib/ops-pulse/cod-pickup';
import { createCodMaster, deleteCodMaster, updateCodMaster } from './actions';
import styles from './pickup.module.css';
type Location = {id:string; code:string; name:string; state:string};
type Row = {id:string; location_id:string; station_code:string; state:string; cms_agency:string; agent_name:string; agent_mobile:string; pickup_rule:string; pickup_window_start:string; pickup_window_end:string; updated_at:string};
function Fields({row}: {row?:Row}) {
  const [rule,setRule] = useState(row?.pickup_rule || '');
  return <>
    {row && <><input type="hidden" name="id" value={row.id}/><input type="hidden" name="updated_at" value={row.updated_at}/></>}
    <label>CMS agency<input name="cms_agency" required maxLength={120} defaultValue={row?.cms_agency} placeholder="Agency name" /></label>
    <label>Agent name <small>Optional</small><input name="agent_name" maxLength={160} defaultValue={row?.agent_name} placeholder="Agent name" /></label>
    <label>Mobile number <small>Optional</small><input name="agent_mobile" type="tel" defaultValue={row?.agent_mobile} placeholder="Mobile number" /></label>
    <label>COD deposit rule<select name="pickup_rule" required value={rule} onChange={e=>setRule(e.target.value)}><option value="">Select deposit rule</option>{pickupRules.map(r=><option key={r}>{r}</option>)}</select></label>
    <label>Pickup from · IST<input name="pickup_window_start" type="time" required defaultValue={row?.pickup_window_start} /></label>
    <label>Pickup until · IST<input name="pickup_window_end" type="time" required defaultValue={row?.pickup_window_end} /></label>
    {rule && <p className={styles.formHint}>{pickupDescriptions[rule as PickupRule]}</p>}
  </>;
}
export function PickupMasterClient({locations,rows,canAdd,canEdit,flash}: {locations:Location[];rows:Row[];canAdd:boolean;canEdit:boolean;flash:{error?:string;notice?:string}}) {
  const [query,setQuery] = useState(''), [rule,setRule] = useState(''), [state,setState] = useState('');
  const [adding,setAdding] = useState(false), [editing,setEditing] = useState<string|null>(null), [deleting,setDeleting] = useState<string|null>(null);
  const configured = new Set(rows.map(r=>r.location_id));
  const remaining = locations.filter(l=>!configured.has(l.id));
  const visible = rows.filter(r=>(!rule || r.pickup_rule===rule) && (!state || r.state===state) && `${r.station_code} ${locations.find(l=>l.id===r.location_id)?.name || ''} ${r.cms_agency} ${r.agent_name}`.toLowerCase().includes(query.toLowerCase()));
  const states = [...new Set(rows.map(r=>r.state).filter(Boolean))].sort();
  return <div className={styles.root}>
    {(flash.error || flash.notice) && <p role="status" className={flash.error?styles.error:styles.notice}>{flash.error || flash.notice}</p>}
    <div className={styles.top}><div><strong>{rows.length} configured stations</strong><span>{remaining.length} other authorized locations available to add</span></div><div>{canAdd && <button className="button" onClick={()=>{setAdding(!adding);setEditing(null);}}> {adding?'Cancel':'+ Add station'}</button>}<a className="button secondary" href="/cod/status">View COD status →</a></div></div>
    <div className={styles.rules}>{pickupRules.map(r=><div key={r}><strong>{r}</strong><p>{pickupDescriptions[r]}</p></div>)}</div>
    {adding && <section className={styles.panel}><h2>Add pickup setup</h2><form action={createCodMaster} className={styles.form}>
      <label className={styles.full}>Station<SearchableSelect name="location_id" options={remaining.map(l=>({value:l.id,label:`${l.code} · ${l.name}`,helper:l.state}))} placeholder="Search all authorized locations" required maxOptions={1000}/></label>
      <Fields/><div className={styles.formActions}><SubmitButton>Save pickup setup</SubmitButton><button type="button" className="button secondary" onClick={()=>setAdding(false)}>Cancel</button></div>
    </form></section>}
    <section className={styles.panel}><div className={styles.filters}><label>Search<input placeholder="Station, agency or agent" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>State<select value={state} onChange={e=>setState(e.target.value)}><option value="">All states</option>{states.map(s=><option key={s}>{s}</option>)}</select></label><label>Deposit rule<select value={rule} onChange={e=>setRule(e.target.value)}><option value="">All rules</option>{pickupRules.map(r=><option key={r}>{r}</option>)}</select></label><span>{visible.length} stations</span></div>
      <div className={styles.scroll}><table><thead><tr><th>Station</th><th>State</th><th>CMS agency</th><th>Agent / mobile</th><th>COD deposit rule</th><th>Pickup · IST</th><th>Manage</th></tr></thead><tbody>
        {visible.map(row=><Fragment key={row.id}><tr><td><b>{row.station_code}</b><small>{locations.find(l=>l.id===row.location_id)?.name}</small></td><td>{row.state || '—'}</td><td>{row.cms_agency}</td><td>{row.agent_name || 'Contact not added'}<small>{row.agent_mobile || 'Mobile not added'}</small></td><td><span className={styles.pill}>{row.pickup_rule}</span></td><td className={styles.time}>{row.pickup_window_start}–{row.pickup_window_end}</td><td>{canEdit ? <div className={styles.actions}><button onClick={()=>{setEditing(editing===row.id?null:row.id);setDeleting(null);setAdding(false);}}>Edit</button><button className={styles.delete} onClick={()=>{setDeleting(deleting===row.id?null:row.id);setEditing(null);}}>Delete</button></div>:<span>View only</span>}</td></tr>
        {editing===row.id && <tr><td colSpan={7} className={styles.editor}><h3>Edit {row.station_code} pickup setup</h3><form action={updateCodMaster} className={styles.form}><Fields row={row}/><div className={styles.formActions}><SubmitButton>Save changes</SubmitButton><button type="button" className="button secondary" onClick={()=>setEditing(null)}>Cancel</button></div></form></td></tr>}
        {deleting===row.id && <tr><td colSpan={7} className={styles.editor}><h3>Delete {row.station_code} pickup setup?</h3><p>Timing validation will show “Not configured”. Past COD records and portal settings are retained. You can add this station again.</p><form action={deleteCodMaster}><input type="hidden" name="id" value={row.id}/><input type="hidden" name="updated_at" value={row.updated_at}/><div className={styles.actions}><SubmitButton className="button danger">Delete pickup setup</SubmitButton><button type="button" className="button secondary" onClick={()=>setDeleting(null)}>Cancel</button></div></form></td></tr>}
        </Fragment>)}{!visible.length && <tr><td colSpan={7}>No pickup setups match your filters.</td></tr>}
      </tbody></table></div>
    </section><p className={styles.note}>Rules come from this master, not from an assumed delivery closing time. Partial pickups need cash-at-pickup evidence before a shortage can be determined. Blank contacts remain visible for follow-up.</p>
  </div>;
}
