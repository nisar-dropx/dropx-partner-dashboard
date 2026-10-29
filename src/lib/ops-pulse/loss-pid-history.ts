/** Shared, salary-safe history representation for the tracking timeline and Excel export. */
export type PidEvent = {
  id: string; month: string; case_key: string; source: string; action: string;
  actor: string; at: string; note: string; changes: { field: string; before: string; after: string }[];
};
const privateKeys = new Set(['salary_payable','salary_gross','salary_source','recovery_limit','override_limit','reserved']);
// Import bookkeeping is not a business change. In particular, every refresh briefly
// flips source_present false before restoring rows, which must never appear as two
// user-facing updates.
const metadata = new Set([
  'company_id','id','updated_at','updated_by','updated_by_name','last_seen_at',
  'source_updated_at','source_run_id','source_present','source_file','data_source',
  'final_seen_at','report',
]);
function safe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !privateKeys.has(k)).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,safe(v)]));
  return value;
}
const display = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(safe(value)) : String(value);
function fields(value: Record<string, unknown>, prefix=''): Record<string,unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{
    if(privateKeys.has(key)||(!prefix&&metadata.has(key)))return [];
    const name=prefix?`${prefix}.${key}`:key;
    return item&&typeof item==='object'&&!Array.isArray(item)?Object.entries(fields(item as Record<string,unknown>,name)):[[name,item]];
  }));
}
export function historyChanges(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}) {
  const a=fields(before),b=fields(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(field => display(a[field]) !== display(b[field]))
    .map(field => ({field:field.replaceAll('_',' ').replaceAll('.', ' / '), before:display(a[field]), after:display(b[field])}));
}
export function pidEvent(source: string, row: Record<string, any>): PidEvent {
  const before = row.before_value || row.tracking?.before || (row.from_status ? {status:row.from_status} : {});
  const after = row.after_value || row.tracking?.after || (row.to_status ? {status:row.to_status} : row.snapshot) || {};
  const recordedActor=String(row.actor_name || '').trim();
  const actor=source==='Source' && /source editor not supplied/i.test(recordedActor)
    ? 'Amazon source import (system)'
    : recordedActor || 'System / actor not recorded';
  return {id:`${source}:${row.id}`, month:row.month, case_key:row.case_key, source,
    action:row.action || (after.is_deleted ? 'Plan removed' : after.outcome_label ? `Recovery · ${after.outcome_label}` : 'Recovery updated'),
    actor, at:row.created_at,
    note:row.note || after.remarks || '', changes:historyChanges(before,after)};
}
export const sortPidEvents = (events: PidEvent[]) => events.sort((a,b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
/** Hide migration baselines, transient refresh toggles and exact duplicated audit rows. */
export function meaningfulPidEvents(events: PidEvent[]) {
  const seen=new Set<string>();
  return sortPidEvents([...events]).filter(event=>{
    if(event.action==='Source baseline')return false;
    if(event.source==='Source'&&!event.changes.length&&!event.note.trim())return false;
    const fingerprint=JSON.stringify([
      event.month,event.case_key,event.source,event.action,event.at,event.actor,event.note,event.changes,
    ]);
    if(seen.has(fingerprint))return false;
    seen.add(fingerprint);
    return true;
  });
}
export const historyColumns = ['Tracking ID','Loss month','Case ref','Updated at (IST)','Updated by','Source','Action','Note','Field','Before','After'];
export function historyRows(events: PidEvent[], tidByCase: Map<string,string>) {
  return meaningfulPidEvents(events).flatMap(e => {
    const key=`${e.month}|${e.case_key}`;
    const base=[tidByCase.get(key)||e.case_key,e.month,e.case_key,new Date(e.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}),e.actor,e.source,e.action,e.note];
    return (e.changes.length ? e.changes : [{field:'',before:'',after:''}]).map(c=>[...base,c.field,c.before,c.after]);
  });
}
