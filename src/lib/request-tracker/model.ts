import catalog from './catalog.json';
export type RecordData = Record<string, unknown>;
export type TrackerRow = { kind: string; label: string; portal: string; record: RecordData };
export type TrackerEvent = { source: string; record: RecordData };
export type Related = { kind: string; id: string; reference: string; label: string; status?: string };
export type Detail = TrackerRow & { events: TrackerEvent[]; hasMore: boolean; warnings: string[]; auditSince: string; deleted: boolean; related: Related[]; names: Record<string,string> };
export const sources = catalog;
export function text(row: RecordData, ...keys: string[]) {
  for (const key of keys) { const value = row[key]; if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() && value !== '[Protected]') return String(value); }
  return '';
}
export function human(value: string) { return value.replaceAll('_',' ').replace(/\b\w/g, c=>c.toUpperCase()); }
export function reference(row: RecordData) { return text(row,'request_no','claim_no','request_number','case_number','run_number','requisition_code','audit_number','request_id','dropx_id','id'); }
export function state(row: RecordData) {
 const current=text(row,'status','state');
 if(/^(paid|processed|completed|closed|cancelled|canceled|rejected|withdrawn|resolved|reversed|deleted)$/i.test(current))return current;
 return text(row,'approval_status','status','state') || 'Not recorded';
}
export function eventTime(event: TrackerEvent) { return text(event.record,'recorded_at','created_at','timestamp','at','decided_at'); }
export function eventAction(event: TrackerEvent) { return human(text(event.record,'operation','event_type','event_code','action','status') || (event.source==='workforce_payout_dispute_events'?'Message':'Workflow update')); }
export function eventActor(event: TrackerEvent, names: Record<string,string>) {
 const row=event.record;
 const id=text(row,'actor_id','actor_user_id','approver_user_id','decided_by','actor_profile_id');
 if(event.source==='Database change') return id ? (names[id] || id) : 'Backend / service';
 return text(row,'actor_name','actor_label','actor') || names[id] || id || 'Not recorded';
}
export function waiting(row: RecordData,names: Record<string,string>={}) {
 const status=state(row).toLowerCase();
 if (status.includes('no_approver')) return 'Approver configuration';
 if (/^(paid|processed|completed|closed|cancelled|canceled|rejected|withdrawn|resolved|reversed|deleted)$/.test(status)) return 'No active approval recorded';
 if(status.includes('return')) return 'Requester correction';
 const person=text(row,'current_approver_user_id','assigned_to','assigned_user_id','reviewer_id');
 if(person) return names[person] || person;
 const roles=Array.isArray(row.current_approver_role_ids)?row.current_approver_role_ids:[];
 const role=text(row,'current_approver_role_id');
 if(role || roles.length) return [...new Set([role,...roles].filter(Boolean))].map(id=>names[String(id)]||String(id)).join(', ');
 if(status.includes('processing')) return 'Finance processing';
 if(status==='final_approved'||status==='approved_for_payment') return 'Payout details / Finance';
 return 'Open details to review routing';
}
export function age(value: string, now=Date.now()) {
 const time=Date.parse(value); if(!Number.isFinite(time))return '—';
 const hours=Math.max(0,Math.floor((now-time)/3600000));
 return hours<1?'<1h':hours<48?`${hours}h`:`${Math.floor(hours/24)}d ${hours%24}h`;
}
export function statusTone(value: string) {
 const s=value.toLowerCase();return /reject|fail|blocked|no_approver/.test(s)?'danger':/paid|completed|resolved|final_approved/.test(s)?'success':/return|pending|processing|review/.test(s)?'waiting':'neutral';
}

export function stageSince(detail: Detail) {
 const current=state(detail.record).toLowerCase();
 for(const event of detail.events){
  const r=event.record; const after=r.after_data as RecordData|undefined;
  const changed=Array.isArray(r.changed_fields)?r.changed_fields:[];
  if(event.source==='Database change' && after && (changed.includes('status')||changed.includes('approval_status')) && state(after).toLowerCase()===current)return eventTime(event);
  if(text(r,'to_status').toLowerCase()===current)return eventTime(event);
 }
 return '';
}
